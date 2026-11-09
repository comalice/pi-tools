REPO := $(abspath .)
NODE := $(shell command -v node)
SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user
UNITS := pi-wiki-serve.service pi-memory-ingest.service pi-memory-ingest.timer \
         pi-memory-vector-refresh.service pi-memory-vector-refresh.timer \
         pi-dream.service pi-dream.timer

.PHONY: run ingest maintain dream status test \
        install-systemd uninstall-systemd systemd-status

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

install-systemd: $(SYSTEMD_USER_DIR) ## Install and enable user systemd units
	@for unit in $(UNITS); do \
	  sed -e 's|@REPO@|$(REPO)|g' -e 's|@NODE@|$(NODE)|g' \
	    deploy/systemd/$$unit.in > $(SYSTEMD_USER_DIR)/$$unit; \
	  echo "installed $$unit"; \
	done
	systemctl --user daemon-reload
	systemctl --user enable --now pi-wiki-serve.service
	systemctl --user enable --now pi-memory-ingest.timer
	systemctl --user enable --now pi-memory-vector-refresh.timer
	systemctl --user enable pi-dream.timer
	@echo "---"
	@echo "Units live in $(SYSTEMD_USER_DIR). To survive logout, run: loginctl enable-linger $$USER"
	@echo "Start a dream run now with: systemctl --user start pi-dream.service"

uninstall-systemd: ## Disable and remove the user systemd units
	-systemctl --user disable --now pi-wiki-serve.service pi-memory-ingest.timer \
	  pi-memory-vector-refresh.timer pi-dream.timer 2>/dev/null
	@for unit in $(UNITS); do rm -f $(SYSTEMD_USER_DIR)/$$unit; done
	systemctl --user daemon-reload
	@echo "units removed"

systemd-status: ## Show unit and timer status
	@systemctl --user status pi-wiki-serve.service --no-pager -l | head -12 || true
	@systemctl --user list-timers --no-pager | grep -E "pi-|NEXT" || true
