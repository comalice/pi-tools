export type StateValue = string | { readonly [key: string]: StateValue };

export interface BaseEvent {
  readonly type: string;
}

export interface DoneEvent extends BaseEvent {
  readonly type: `done.${string}`;
  readonly state: string;
}

export type EffectSpec<C, E extends BaseEvent, F> =
  | F
  | ((ctx: C, event: E) => F | readonly F[] | null | undefined);

export interface Transition<C, E extends BaseEvent, F> {
  readonly target?: string;
  readonly guard?: (ctx: C, event: E, value: StateValue) => boolean;
  readonly assign?: (ctx: C, event: E) => C;
  readonly effects?: readonly EffectSpec<C, E, F>[];
}

export type TransitionConfig<C, E extends BaseEvent, F> =
  | Transition<C, E, F>
  | readonly Transition<C, E, F>[];

export interface StateNode<C, E extends BaseEvent, F> {
  readonly type?: "atomic" | "compound" | "parallel" | "final";
  readonly initial?: string;
  readonly states?: Readonly<Record<string, StateNode<C, E, F>>>;
  readonly entry?: readonly EffectSpec<C, E, F>[];
  readonly exit?: readonly EffectSpec<C, E, F>[];
  readonly on?: Readonly<Record<string, TransitionConfig<C, E, F>>>;
}

function nodeType<C, E extends BaseEvent, F>(node: StateNode<C, E, F>): "atomic" | "compound" | "parallel" | "final" {
  return node.type ?? "atomic";
}

export interface Chart<C, E extends BaseEvent, F> {
  readonly id: string;
  readonly root: StateNode<C, E, F>;
}

export interface Snapshot<C> {
  readonly value: StateValue;
  readonly context: C;
}

export interface StepTrace {
  readonly event: string;
  readonly from: StateValue;
  readonly to: StateValue;
}

export interface StepResult<C, F> {
  readonly snapshot: Snapshot<C>;
  readonly changed: boolean;
  readonly effects: readonly F[];
  readonly trace: readonly StepTrace[];
}

function resolveEffects<C, E extends BaseEvent, F>(
  specs: readonly EffectSpec<C, E, F>[] | undefined,
  ctx: C,
  event: E,
  out: F[],
): void {
  if (!specs) return;
  for (const spec of specs) {
    const res = typeof spec === "function"
      ? (spec as (c: C, e: E) => F | readonly F[] | null | undefined)(ctx, event)
      : spec;
    if (res == null) continue;
    if (Array.isArray(res)) {
      for (const item of res) out.push(item as F);
    } else {
      out.push(res as F);
    }
  }
}

function enterNode<C, E extends BaseEvent, F>(
  node: StateNode<C, E, F>,
  path: readonly string[],
  ctx: C,
  event: E,
  effects: F[],
  internalQueue: DoneEvent[],
  targetSubpath?: readonly string[],
): StateValue {
  resolveEffects(node.entry, ctx, event, effects);

  const kind = nodeType(node);
  if (kind === "atomic" || kind === "final") {
    if (kind === "final" && path.length >= 2) {
      const parentName = path[path.length - 2];
      const finalName = path[path.length - 1];
      internalQueue.push({ type: `done.${parentName}`, state: finalName });
    }
    return path[path.length - 1] ?? "";
  }

  if (kind === "compound") {
    const states = node.states;
    if (!states) throw new Error(`compound state ${path.join(".") || "<root>"} has no child states`);
    const nextChild = targetSubpath && targetSubpath.length > 0 ? targetSubpath[0] : node.initial;
    if (!nextChild || !(nextChild in states)) {
      throw new Error(`invalid initial/target child "${String(nextChild)}" in ${path.join(".") || "<root>"}`);
    }
    const childNode = states[nextChild];
    const childValue = enterNode(
      childNode,
      [...path, nextChild],
      ctx,
      event,
      effects,
      internalQueue,
      targetSubpath && targetSubpath.length > 1 ? targetSubpath.slice(1) : undefined,
    );
    const childKind = nodeType(childNode);
    if (childKind === "atomic" || childKind === "final") {
      return nextChild;
    }
    return { [nextChild]: childValue };
  }

  // parallel
  const states = node.states;
  if (!states) throw new Error(`parallel state ${path.join(".") || "<root>"} has no regions`);
  const value: Record<string, StateValue> = {};
  for (const regionKey of Object.keys(states)) {
    value[regionKey] = enterNode(
      states[regionKey],
      [...path, regionKey],
      ctx,
      event,
      effects,
      internalQueue,
    );
  }
  return value;
}

function exitNode<C, E extends BaseEvent, F>(
  node: StateNode<C, E, F>,
  value: StateValue,
  ctx: C,
  event: E,
  effects: F[],
): void {
  const kind = nodeType(node);
  if (kind === "compound" && node.states) {
    const childKey = typeof value === "string" ? value : Object.keys(value)[0];
    const childNode = node.states[childKey];
    if (childNode) {
      const childVal = typeof value === "string" ? value : value[childKey];
      exitNode(childNode, childVal, ctx, event, effects);
    }
  } else if (kind === "parallel" && node.states && typeof value === "object") {
    for (const regionKey of Object.keys(node.states)) {
      if (regionKey in value) {
        exitNode(node.states[regionKey], value[regionKey], ctx, event, effects);
      }
    }
  }
  resolveEffects(node.exit, ctx, event, effects);
}

function pickTransition<C, E extends BaseEvent, F>(
  node: StateNode<C, E, F>,
  ctx: C,
  event: E,
  rootValue: StateValue,
): Transition<C, E, F> | undefined {
  const cfg = node.on?.[event.type];
  if (!cfg) return undefined;
  const list = Array.isArray(cfg) ? cfg : [cfg];
  for (const t of list) {
    if (!t.guard || t.guard(ctx, event, rootValue)) return t;
  }
  return undefined;
}

interface MicroResult<C> {
  value: StateValue;
  context: C;
  matched: boolean;
}

function stepNode<C, E extends BaseEvent, F>(
  node: StateNode<C, E, F>,
  path: readonly string[],
  value: StateValue,
  ctx: C,
  event: E,
  rootValue: StateValue,
  effects: F[],
  internalQueue: DoneEvent[],
): MicroResult<C> {
  const kind = nodeType(node);
  if (kind === "parallel" && node.states && typeof value === "object") {
    let nextCtx = ctx;
    let anyMatched = false;
    const nextValue: Record<string, StateValue> = {};
    for (const regionKey of Object.keys(node.states)) {
      const res = stepNode(
        node.states[regionKey],
        [...path, regionKey],
        value[regionKey],
        nextCtx,
        event,
        rootValue,
        effects,
        internalQueue,
      );
      nextValue[regionKey] = res.value;
      nextCtx = res.context;
      if (res.matched) anyMatched = true;
    }
    return { value: anyMatched ? nextValue : value, context: nextCtx, matched: anyMatched };
  }

  if (kind === "compound" && node.states) {
    const childKey = typeof value === "string" ? value : Object.keys(value)[0];
    const childNode = node.states[childKey];
    if (!childNode) {
      throw new Error(`active child "${childKey}" not found in ${path.join(".") || "<root>"}`);
    }
    const childVal = typeof value === "string" ? childKey : value[childKey];
    const childKind = nodeType(childNode);

    // 1. Try deepest active child first (SCXML bubbling order)
    if (childKind === "compound" || childKind === "parallel") {
      const nested = stepNode(
        childNode,
        [...path, childKey],
        childVal,
        ctx,
        event,
        rootValue,
        effects,
        internalQueue,
      );
      if (nested.matched) {
        return {
          value: { [childKey]: nested.value },
          context: nested.context,
          matched: true,
        };
      }
    }

    // 2. Check transition defined directly on the active child (targeting a sibling in this compound)
    const childTransition = pickTransition(childNode, ctx, event, rootValue);
    if (childTransition) {
      return applyCompoundTransition(
        node,
        path,
        childKey,
        childNode,
        childVal,
        childTransition,
        ctx,
        event,
        effects,
        internalQueue,
      );
    }

    return { value, context: ctx, matched: false };
  }

  // Atomic or final at root (uncommon, handled for completeness)
  const t = pickTransition(node, ctx, event, rootValue);
  if (!t) return { value, context: ctx, matched: false };
  const nextCtx = t.assign ? t.assign(ctx, event) : ctx;
  resolveEffects(t.effects, nextCtx, event, effects);
  return { value, context: nextCtx, matched: true };
}

function applyCompoundTransition<C, E extends BaseEvent, F>(
  parent: StateNode<C, E, F>,
  parentPath: readonly string[],
  childKey: string,
  childNode: StateNode<C, E, F>,
  childVal: StateValue,
  transition: Transition<C, E, F>,
  ctx: C,
  event: E,
  effects: F[],
  internalQueue: DoneEvent[],
): MicroResult<C> {
  // Internal transition (no target): keep current state, run assign + effects
  if (!transition.target) {
    const nextCtx = transition.assign ? transition.assign(ctx, event) : ctx;
    resolveEffects(transition.effects, nextCtx, event, effects);
    const preserved = nodeType(childNode) === "atomic" || nodeType(childNode) === "final"
      ? childKey
      : { [childKey]: childVal };
    return { value: preserved, context: nextCtx, matched: true };
  }

  const states = parent.states!;
  const targetParts = transition.target.split(".");
  const targetChildKey = targetParts[0];
  const targetChild = states[targetChildKey];
  if (!targetChild) {
    throw new Error(`unknown target "${transition.target}" in ${parentPath.join(".") || "<root>"}`);
  }

  exitNode(childNode, childVal, ctx, event, effects);
  const nextCtx = transition.assign ? transition.assign(ctx, event) : ctx;
  resolveEffects(transition.effects, nextCtx, event, effects);

  const entered = enterNode(
    targetChild,
    [...parentPath, targetChildKey],
    nextCtx,
    event,
    effects,
    internalQueue,
    targetParts.length > 1 ? targetParts.slice(1) : undefined,
  );
  const nextValue: StateValue = nodeType(targetChild) === "atomic" || nodeType(targetChild) === "final"
    ? targetChildKey
    : { [targetChildKey]: entered };

  return { value: nextValue, context: nextCtx, matched: true };
}

export function initialSnapshot<C, E extends BaseEvent, F>(
  chart: Chart<C, E, F>,
  context: C,
): { snapshot: Snapshot<C>; effects: readonly F[] } {
  const effects: F[] = [];
  const internalQueue: DoneEvent[] = [];
  const initEvent = { type: "$init" } as E;
  const value = enterNode(chart.root, [], context, initEvent, effects, internalQueue);
  return { snapshot: { value, context }, effects };
}

export function step<C, E extends BaseEvent, F>(
  chart: Chart<C, E, F>,
  snapshot: Snapshot<C>,
  event: E,
  maxMicrosteps = 32,
): StepResult<C, F> {
  const effects: F[] = [];
  const trace: StepTrace[] = [];
  const queue: BaseEvent[] = [event];
  let currentValue = snapshot.value;
  let currentContext = snapshot.context;
  let anyChanged = false;
  let steps = 0;

  while (queue.length > 0) {
    if (++steps > maxMicrosteps) {
      throw new Error(`statechart "${chart.id}" exceeded ${maxMicrosteps} microsteps (possible cycle)`);
    }
    const nextEvent = queue.shift() as E;
    const internalQueue: DoneEvent[] = [];
    const from = currentValue;
    const res = stepNode(
      chart.root,
      [],
      currentValue,
      currentContext,
      nextEvent,
      currentValue,
      effects,
      internalQueue,
    );
    if (res.matched) {
      anyChanged = true;
      currentValue = res.value;
      currentContext = res.context;
      trace.push({ event: nextEvent.type, from, to: currentValue });
    }
    for (const doneEvt of internalQueue) queue.push(doneEvt);
  }

  return {
    snapshot: { value: currentValue, context: currentContext },
    changed: anyChanged,
    effects,
    trace,
  };
}

export function matches(value: StateValue, path: string): boolean {
  const parts = path.split(".");
  let cur: StateValue = value;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof cur === "string") {
      return i === parts.length - 1 && cur === part;
    }
    if (!(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}
