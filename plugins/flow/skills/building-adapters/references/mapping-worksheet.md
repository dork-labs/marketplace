# Mapping worksheet

Fill-in tables for Step 2. Copy them into your notes, fill the right-hand columns from your tracker, then inline the result into the adapter's `WorkItem` section. The rules each table follows are [`<flow-root>/adapters/SPEC.md`](../../../adapters/SPEC.md) section 2; every field it lists as required must be present.

## 2a. State -> `stateCategory`

List **every** state your tracker defines. Each maps to exactly one of the five categories; the holding or untriaged state maps to `backlog`.

| Your tracker's state (display name) | `stateCategory` (backlog \| unstarted \| started \| completed \| canceled) |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `<state 1>`                         | `<category>`                                                               |
| ...                                 | ...                                                                        |

- Tracker exposes a state's category natively (a `type` or `category` field): use it.
- Only display names: build this map once from the tracker's state list and reuse it in every read verb.

Worked example, tracker "Acme":

| Acme state                  | `stateCategory` |
| --------------------------- | --------------- |
| `Inbox` (untriaged holding) | `backlog`       |
| `Backlog`                   | `backlog`       |
| `Selected`                  | `unstarted`     |
| `In Progress`, `In Review`  | `started`       |
| `Shipped`                   | `completed`     |
| `Won't Do`                  | `canceled`      |

## 2b. Native labels -> generic families

| Family    | Leaves the engine expects                                                                                | Your tracker's native label(s)   |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `agent/*` | `agent/ready`, `agent/claimed`, `agent/completed`, `agent/needs-input`                                   | `<native ready / claimed / ...>` |
| `stage/*` | `stage/capture` ... `stage/done`                                                                         | `<native per-stage label>`       |
| `type/*`  | `type/idea`, `type/research`, `type/hypothesis`, `type/task`, `type/monitor`, `type/signal`, `type/meta` | `<native per-type label>`        |

- Build the leaf-to-family map from the tracker's label list: for grouped labels, the family is the parent and the leaf is the child.
- Apply it in every read verb that returns `labels[]`; derive `agentDisposition` and `type` from the result.

Worked example: Acme shows a grouped label as its bare leaf, so the adapter re-namespaces on the way out.

| Acme leaf on the item | On `labels[]`   |
| --------------------- | --------------- |
| `ready`               | `agent/ready`   |
| `claimed`             | `agent/claimed` |
| `verify`              | `stage/verify`  |
| `research`            | `type/research` |

## 2c. Native fields

Name the source of each; a missing one is `undefined` (SPEC section 2 has the types and the neutral rules).

| `WorkItem` field | Source on your tracker                                  |
| ---------------- | ------------------------------------------------------- |
| `priority`       | native priority field (never a label)                   |
| `size`           | native estimate field, shape unconverted                |
| `assignee`       | native assignee account id                              |
| `project`        | native project -> `{ id, name, stateCategory?, lead? }` |
| `parent`         | native parent -> its `identifier` (`null` if top-level) |
| `relations`      | the **typed** relation graph, as `identifier`s          |
| `createdAt`      | native creation timestamp, ISO-8601                     |
