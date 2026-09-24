# My Second Brain Playground

This context defines the language for the executable My Second Brain product.
Use these terms in package, directory, file, type, command, skill, and cast-role
names.

## Product boundary

**Playground Plugin**:
The packaged executable product that owns its CLI tools, skills, hooks, schemas,
workflow behavior, and integration adapters.
_Avoid_: Project, system, Agent Kit

**Vertical Slice**:
A bounded end-to-end journey that tests one product question and leaves
recoverable evidence.
_Avoid_: Feature, phase, milestone

**Prototype**:
An experimental surface used to answer a named design question. Its evidence
supports only the journey that was exercised.
_Avoid_: Product, implementation, proof of the whole system

**Qualification**:
Independent evidence that a Vertical Slice satisfies its stated criteria in
the intended environment.
_Avoid_: Test, review, validation

## Work and owners

**Product Packet**:
The Vault-owned record of product intent, research, accepted decisions, evidence,
and future-slice planning.
_Avoid_: Backlog, spec, plugin docs

**Spec**:
A GitHub Issue that defines a repository-bound problem, outcome, and acceptance
contract.
_Avoid_: Project packet, plan, design doc

**Ticket**:
A GitHub Issue that defines one implementable unit derived from a Spec.
_Avoid_: Bead, task, slice

**Bead**:
A Beads-owned record in the Durable Work Graph for executable work, dependencies,
claims, gates, and checkpoints.
_Avoid_: Ticket, card, Agent Ledger Task

**Legacy Agent Ledger**:
Nathan's earlier task-ledger product that the Playground Plugin is intended to
replace through qualified Vertical Slices.
_Avoid_: Beads, AgentKit

**Board Projection**:
A human-readable view over owner records that can be rebuilt without becoming
their authority.
_Avoid_: Tracker, database, source of truth

## Workflow graph

**Workflow Graph**:
A reusable structure of work, dependencies, gates, fan-out, fan-in, and
completion conditions.
_Avoid_: Flow, pipeline, process

**Workflow Kind**:
The named class of bounded journey that one run selects, defined by one
Workflow Reference. A Workflow Kind is independent of the Cast Role, model,
and Harness that perform the run.
_Avoid_: Workflow type, track, mode

**Workflow Reference**:
The revisioned definition of one Workflow Kind's Workflow Graph. A run keeps
the revision it selected, so a later revision never rewrites an active run.
_Avoid_: Spec, graph definition, template

**Workflow Core**:
The Harness-neutral domain behavior shared by Workflow Adapters.
_Avoid_: Engine, framework, orchestrator

**Workflow Adapter**:
A boundary that maps an owner or work domain onto the Workflow Core.
_Avoid_: Plugin, integration, connector

**Harness Adapter**:
A boundary that exposes plugin behavior through one Harness without changing
the Workflow Core.
_Avoid_: Workflow Adapter, shim, wrapper

**Gate**:
A declared condition that controls whether work can advance.
_Avoid_: Approval, check, status

**Checkpoint**:
A durable observation of current work, evidence, and the next safe action.
_Avoid_: Comment, update, log

**Evidence Receipt**:
A pointer to observed output that supports one claimed state transition.
_Avoid_: Proof, log, completion message

## Cast and execution

**Cast Member**:
A named responsibility participating in a workflow. A Cast Member is independent
of the model, Harness, and machine selected for one run.
_Avoid_: Agent, bot, model

**Cast Role**:
The durable contract for one Cast Member's purpose, authority, inputs, outputs,
and dismissal condition.
_Avoid_: Prompt, persona, job

**Capability**:
A declared kind of work a candidate runtime can perform for a Cast Role.
_Avoid_: Model strength, tool, skill

**Cast Registry**:
The inventory of Cast Roles and candidate capabilities available to the product.
_Avoid_: Model list, agent catalog

**Cast Resolver**:
The policy that selects a model, Harness, and machine for a Cast Role at launch
time.
_Avoid_: Router, Stage Manager, scheduler

**Stage Manager**:
The coordinating Cast Member that assigns work, preserves boundaries, receives
handbacks, requests repair, and dismisses finished Cast Members.
_Avoid_: Supervisor, orchestrator, coordinator

**Model Guide**:
Reviewed guidance for one exact model identity running in one Harness, with
its sources, review date and applicable boundary. It applies only to the
performer whose observed model and Harness it names.
_Avoid_: Prompt pack, model notes, persona

**Live Cast**:
The Cast Members currently visible and in flight for one Herdr Session.
_Avoid_: Team, swarm, agents

**Herdr Session**:
The Herdr-owned live execution container that holds the Live Cast and their panes.
_Avoid_: Project, workflow, board

**Pane**:
A Herdr-owned terminal surface for one active Cast Member. A Pane is an execution
view, not durable work state.
_Avoid_: Agent, task, session

## Continuity

**Handback**:
A Cast Member's structured return of outcome, evidence, remaining gaps, and the
next safe action.
_Avoid_: Handoff, summary, completion message

**Repair**:
Bounded follow-up work requested after a Handback fails its acceptance gate.
_Avoid_: Retry, redo, fix loop

**Retirement**:
The accepted dismissal of a finished Cast Member after its Handback and evidence
are preserved.
_Avoid_: Close, kill, archive

**Resume Panel**:
The compact view that lets a person or Cast Member recover current intent,
accepted decisions, evidence, Live Cast, and the next safe action.
_Avoid_: Context dump, dashboard, memory

**Compaction Refresh**:
The recovery transition that reconstructs a Resume Panel from current owners
after a Harness compacts conversation context.
_Avoid_: Session summary, transcript replay, memory restore
