# AI-Agent Pattern Family

Entry contract, classification, and admission states live in
[`pattern-index.md`](pattern-index.md).

Fixed Workflow is a family label covering the first three canonical entries.
It names a shape, not an entry, so it reaches no verdict of its own.

## Canonical Patterns (`admitted`)

### Prompt Chaining

- **Pressure**: One call carries several distinct sub-tasks and degrades on all
  of them.
- **Intent**: Decompose a task into a fixed sequence where each step consumes
  the prior output.
- **Applicability**: The decomposition is known before execution.
- **Participants and collaboration**: Caller; ordered steps; optional gate
  between steps.
- **Consequences**: Higher accuracy per step; added latency; a failed step
  stops the chain.
- **Nearest alternative**: Parallelization, when steps are independent.
- **Source**: Anthropic, Building Effective Agents.
- **Corroboration**: Widespread framework implementation.
- **Owner status**: active. `last_verified`: 2026-08-17.

### Routing

- **Pressure**: Distinct input classes need distinct handling, and one prompt
  serving all of them serves none well.
- **Intent**: Classify an input, then dispatch it to one specialized follower.
- **Applicability**: Classes are separable and the classifier is cheaper than
  the handler.
- **Participants and collaboration**: Classifier; specialized handlers. The
  classifier selects and does not supervise.
- **Consequences**: Separation of concerns; misclassification propagates.
- **Nearest alternative**: Manager and Specialists, which keeps ownership
  after dispatch; Routing hands the input on and stops.
- **Source**: Anthropic, Building Effective Agents.
- **Corroboration**: Widespread framework implementation.
- **Owner status**: active. `last_verified`: 2026-08-17.

### Parallelization

- **Pressure**: Independent subtasks run in sequence and pay avoidable latency,
  or one judgement needs several independent looks.
- **Intent**: Run subtasks concurrently, then aggregate, by sectioning
  independent parts or voting on repeated attempts.
- **Applicability**: Subtasks share no ordering dependency.
- **Participants and collaboration**: Dispatcher; concurrent workers;
  aggregator.
- **Consequences**: Lower latency and better coverage; higher token cost;
  aggregation logic becomes a seam.
- **Nearest alternative**: Orchestrator-Workers, when the subtasks are unknown
  until runtime.
- **Source**: Anthropic, Building Effective Agents.
- **Corroboration**: Widespread framework implementation.
- **Owner status**: active. `last_verified`: 2026-08-17.

### Orchestrator-Workers

- **Pressure**: The subtasks cannot be listed before the task is read.
- **Intent**: One orchestrator decomposes at runtime, delegates to workers, and
  synthesizes their results.
- **Applicability**: Decomposition depends on input the caller has not seen.
- **Participants and collaboration**: Orchestrator; dynamically created
  workers; synthesis step held by the orchestrator.
- **Consequences**: Handles open-ended work; costs orchestration overhead and
  unpredictable spend.
- **Nearest alternative**: Parallelization, which fixes the decomposition
  in advance; this one derives it at runtime.
- **Source**: Anthropic, Building Effective Agents.
- **Corroboration**: Widespread framework implementation.
- **Owner status**: active. `last_verified`: 2026-08-17.

### Evaluator-Optimizer

- **Pressure**: First output falls short and clear evaluation criteria exist.
- **Intent**: Loop a generator against an evaluator until the criteria pass.
- **Applicability**: The evaluation signal is more reliable than one-shot
  generation.
- **Participants and collaboration**: Generator; evaluator; loop bound.
- **Consequences**: Measurable quality gain; unbounded loops without a stop
  condition.
- **Nearest alternative**: Verification Gate, which admits or blocks once.
  This one iterates.
- **Source**: Anthropic, Building Effective Agents.
- **Corroboration**: Widespread framework implementation.
- **Owner status**: active. `last_verified`: 2026-08-17.

### Manager and Specialists

- **Pressure**: One agent's context and tool surface span several domains.
- **Intent**: A manager retains ownership of the task and consults specialists
  as subordinates.
- **Applicability**: Control belongs in one place while expertise divides.
- **Participants and collaboration**: Manager holding the task; specialists
  returning results to the manager.
- **Consequences**: Bounded context per specialist; the manager becomes a
  bottleneck.
- **Nearest alternative**: Handoff, which transfers ownership. The manager
  keeps it.
- **Source**: OpenAI, A Practical Guide to Building Agents.
- **Corroboration**: Multi-agent framework implementations.
- **Owner status**: active. `last_verified`: 2026-08-17.

### Handoff

- **Pressure**: The conversation moves into a domain the current agent does not
  own.
- **Intent**: Transfer task ownership, with context, to another agent that then
  holds it.
- **Applicability**: The receiver continues the task rather than returning a
  result.
- **Participants and collaboration**: Sending agent; receiving agent; context
  carried across.
- **Consequences**: Clean ownership; lost context when the transfer is thin,
  and no single supervising view.
- **Nearest alternative**: Manager and Specialists, where ownership
  returns. Here it moves and stays moved.
- **Source**: OpenAI, A Practical Guide to Building Agents.
- **Corroboration**: Multi-agent framework implementations.
- **Owner status**: active. `last_verified`: 2026-08-17.

### ReAct

- **Pressure**: Reasoning alone drifts from the environment's actual state.
- **Intent**: Interleave reasoning with tool actions so each observation
  informs the next thought.
- **Applicability**: An environment returns observations the model cannot
  predict.
- **Participants and collaboration**: Reasoner; tool surface; observation loop.
- **Consequences**: Grounded trajectories; longer traces and looping risk.
- **Nearest alternative**: Prompt Chaining, when no environment feedback exists.
- **Source**: Yao et al., ReAct (2022).
- **Corroboration**: Broad agent-framework implementation.
- **Owner status**: active. `last_verified`: 2026-08-17.

### Human Approval Gate

- **Pressure**: An action is irreversible, public, costly, or crosses a
  permission boundary.
- **Intent**: Halt before the action and require an explicit human decision.
- **Applicability**: The consequence outruns the agent's authority.
- **Participants and collaboration**: Agent; paused action; human decision;
  resumed or abandoned path.
- **Consequences**: Bounded blast radius; added latency, and gate fatigue when
  it fires too often.
- **Nearest alternative**: Risk-Tiered Tool Authorization, which decides
  which actions need a gate. This one is the gate.
- **Source**: OpenAI, A Practical Guide to Building Agents.
- **Corroboration**: Standard agent-platform control.
- **Owner status**: active. `last_verified`: 2026-08-17.

## Practice Patterns (`admitted`)

### Risk-Tiered Tool Authorization

- **Pressure**: A flat tool permission treats a read and a deletion alike.
- **Intent**: Sort tools into risk tiers, each with its own authorization rule.
- **Applicability**: The tool surface spans materially different consequences.
- **Participants and collaboration**: Tier policy; tool registry; escalation
  path to a Human Approval Gate.
- **Consequences**: Proportionate friction; a stale tier map misclassifies.
- **Nearest alternative**: Human Approval Gate on every call.
- **Source**: OpenAI, A Practical Guide to Building Agents (guardrails).
- **Corroboration**: 60-day scan shows current practice with variable
  implementations.
- **Owner status**: active. `last_verified`: 2026-08-20.

### Verification Gate

- **Pressure**: A claimed completion arrives without evidence.
- **Intent**: Block progress until a check produces an Execution Receipt: the
  evidence artifact naming what ran and what it proved.
- **Applicability**: A deterministic or reviewable check exists.
- **Participants and collaboration**: Claimed result; verifier; receipt;
  gated next step.
- **Consequences**: Claims become falsifiable; a weak verifier passes weak work.
- **Nearest alternative**: Evaluator-Optimizer, when the check should drive
  iteration instead of a single admission.
- **Source**: OpenAI, A Practical Guide to Building Agents (guardrails).
- **Corroboration**: 60-day scan shows current practice with variable
  implementations.
- **Owner status**: active. `last_verified`: 2026-08-20.

### Progressive-Disclosure Skill

- **Pressure**: Always-loaded instructions crowd the context window.
- **Intent**: Hold a short pointer in context and load the body only when its
  trigger fires.
- **Applicability**: The material serves some runs rather than every run.
- **Participants and collaboration**: Context pointer; disclosed body;
  triggering condition.
- **Consequences**: Lower context load; a weak pointer leaves the body
  unreached.
- **Source**: Anthropic Agent Skills documentation.
- **Corroboration**: Firecrawl community evidence for a recurring structure.
- **Owner status**: active. `last_verified`: 2026-08-20.

## Reference-Only

Deferred at best until stronger identity evidence arrives: Context Packet
Handoff, Selective External Memory, Idempotent Recovery, Group Chat,
Multi-Agent Debate, Supervisor or Swarm labels, Planner-Executor-Reviewer role
sequences.

## Rejected As Pattern

A capability, protocol, framework, or role label carries no pattern identity of
its own: tools and function calling, generic memory, retrieval, MCP, A2A,
generic planning, framework-first architecture, uncontrolled self-improvement
or reflection loops.

An admitted entry using one of these does not promote it.
