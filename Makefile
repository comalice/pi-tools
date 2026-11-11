REPO := $(abspath .)
NODE := $(shell command -v node)
PI_WIKI_BIND ?= 127.0.0.1
PI_HUB_BIND ?= 127.0.0.1
PI_HUB_PORT ?= 6342
SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user
UNITS := pi-wiki-serve.service pi-memory-hub.service pi-memory-ingest.service pi-memory-ingest.timer \
         pi-memory-vector-refresh.service pi-memory-vector-refresh.timer \
         pi-dream.service pi-dream.timer
SPOKE_UNITS := pi-memory-push.service pi-memory-push.timer

.PHONY: run ingest maintain dream status test \
        install-systemd uninstall-systemd install-spoke uninstall-spoke systemd-status install-bin

# --- Running things directly -------------------------------------------------

run: ## Wiki web front-end in the foreground (Ctrl-C to stop)
	$(NODE) --experimental-strip-types src/wiki/cli.ts serve

ingest: ## Ingest all archive sources (pi, opencode, claude, wiki)
	$(NODE) --experimental-strip-types src/memory/cli.ts ingest

maintain: ingest ## Ingest, then self-gating vector refresh
	$(NODE) --experimental-strip-types src/memory/cli.ts vector-refresh

dream: ## Launch the dream runner in the background (30-day window)
	@mkdir -p $(HOME)/.pi/agent/dream
	nohup $(NODE) --experimental-strip-types src/dream/runner.ts --since 30d \
	  --model gladiator/nemotron-3-super --parallel 3 \
	  >> $(HOME)/.pi/agent/dream/launch.log 2>&1 &
	@sleep 3; tail -n 3 $(HOME)/.pi/agent/dream/launch.log

status: ## Archive status and dream-run summary
	@$(NODE) --experimental-strip-types src/memory/cli.ts status
	@python3 -c "import json,collections; s=json.load(open('$(HOME)/.pi/agent/dream/state.json')); \
	  print('dream:', dict(collections.Counter(v['status'] for v in s['sessions'].values())))" 2>/dev/null || true

test: ## Full test suite
	npm test

# --- systemd user units ------------------------------------------------------

$(SYSTEMD_USER_DIR):
	mkdir -p $(SYSTEMD_USER_DIR)

# The pi extensions import npm packages (diff, ts-morph); a fresh clone has no
# node_modules and pi then fails to load them. Keep deps installed as part of
# "install the thing". Skip with a note when npm is unavailable.
node_modules: package-lock.json
	@if command -v npm >/dev/null 2>&1; then \
	  npm ci; \
	else \
	  echo "note: npm not found; run 'npm ci' after installing npm — pi extensions needing npm deps will not load."; \
	fi

install-bin: node_modules ## Install pi-memory/pi-wiki/pi-dream shims into ~/.local/bin and register the package with pi
	@mkdir -p $(HOME)/.local/bin
	@for cmd in memory wiki dream; do \
	  sed 's|REPO|$(REPO)|g' deploy/bin/pi-$$cmd > $(HOME)/.local/bin/pi-$$cmd; \
	  chmod +x $(HOME)/.local/bin/pi-$$cmd; \
	  echo "installed $(HOME)/.local/bin/pi-$$cmd"; \
	done
	@if command -v pi >/dev/null 2>&1; then \
	  if pi list 2>/dev/null | grep -qF "$(CURDIR)"; then \
	    echo "pi package already registered for $(CURDIR)"; \
	  else \
	    pi install "$(CURDIR)" && echo "registered $(CURDIR) as a pi package"; \
	  fi; \
	else \
	  echo "note: pi not found on PATH; skipping pi package registration."; \
	  echo "      install pi and run: pi install $(CURDIR)"; \
	fi

install-systemd: $(SYSTEMD_USER_DIR) ## Install and enable user systemd units
	@for unit in $(UNITS); do \
	  sed -e 's|@REPO@|$(REPO)|g' -e 's|@NODE@|$(NODE)|g' \
	    -e 's|@PI_WIKI_BIND@|$(PI_WIKI_BIND)|g' \
	    -e 's|@PI_HUB_BIND@|$(PI_HUB_BIND)|g' -e 's|@PI_HUB_PORT@|$(PI_HUB_PORT)|g' \
	    deploy/systemd/$$unit.in > $(SYSTEMD_USER_DIR)/$$unit; \
	  echo "installed $$unit"; \
	done
	systemctl --user daemon-reload
	systemctl --user enable --now pi-wiki-serve.service
	systemctl --user enable --now pi-memory-hub.service
	systemctl --user enable --now pi-memory-ingest.timer
	systemctl --user enable --now pi-memory-vector-refresh.timer
	systemctl --user enable pi-dream.timer
	@echo "---"
	@echo "Units live in $(SYSTEMD_USER_DIR). To survive logout, run: loginctl enable-linger $$USER"
	@echo "Start a dream run now with: systemctl --user start pi-dream.service"

install-spoke: $(SYSTEMD_USER_DIR) ## Install and enable the spoke-side Pi session push timer
	@for unit in $(SPOKE_UNITS); do \
	  sed -e 's|@REPO@|$(REPO)|g' -e 's|@NODE@|$(NODE)|g' \
	    deploy/systemd/$$unit.in > $(SYSTEMD_USER_DIR)/$$unit; \
	  echo "installed $$unit"; \
	done
	systemctl --user daemon-reload
	systemctl --user enable --now pi-memory-push.timer
	@echo "Spoke push timer enabled. Configure ~/.pi/agent/memory/hub.json with memory join first."

uninstall-spoke: ## Disable and remove the spoke-side push timer
	-systemctl --user disable --now pi-memory-push.timer 2>/dev/null
	@for unit in $(SPOKE_UNITS); do rm -f $(SYSTEMD_USER_DIR)/$$unit; done
	systemctl --user daemon-reload
	@echo "Spoke push units removed"

uninstall-systemd: ## Disable and remove the user systemd units
	-systemctl --user disable --now pi-wiki-serve.service pi-memory-hub.service pi-memory-ingest.timer \
	  pi-memory-vector-refresh.timer pi-dream.timer 2>/dev/null
	@for unit in $(UNITS); do rm -f $(SYSTEMD_USER_DIR)/$$unit; done
	systemctl --user daemon-reload
	@echo "units removed"

systemd-status: ## Show unit and timer status
	@systemctl --user status pi-wiki-serve.service pi-memory-hub.service --no-pager -l | head -20 || true
	@systemctl --user list-timers --no-pager | grep -E "pi-|NEXT" || true
