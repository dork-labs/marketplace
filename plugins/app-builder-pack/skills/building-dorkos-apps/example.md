# Worked example: a hello card

Request: "Put a small card on my dashboard that says hello."

Nothing here needs a network, a key, server code or agent tools, so the smallest
template does: `dashboard-card`.

## 1. Scaffold

```
create_extension(
  name: "hello-card",
  description: "A dashboard card that says hello. Reads nothing, sends nothing.",
  template: "dashboard-card"
)
```

Reply (trimmed):

```json
{
  "id": "hello-card",
  "status": "compiled",
  "bundleReady": true,
  "files": ["extension.json", "index.ts"],
  "autoApproved": { "runtime": "in-process", "net": [], "run": [], "agents": false }
}
```

`compiled` is the build. `autoApproved` appears because this is a Trusted install and
the starter is untouched. It says what the template may run with: in-process, no hosts,
no commands, no agent access. The first file you change goes back to the person before
it runs, so say that when you report it. If the reply says `approval_required` instead,
it's waiting for the person: tell them, and call again with the token only after they
approve.

## 2. The files

`extension.json`, unchanged from the starter: only one contribution, no
`serverCapabilities`, no `tools`, no `capabilities.events`.

```json
{
  "id": "hello-card",
  "name": "Hello Card",
  "version": "0.1.0",
  "description": "A dashboard card that says hello. Reads nothing, sends nothing.",
  "minHostVersion": "0.1.0",
  "contributions": { "dashboard.sections": true }
}
```

`index.ts` registers one component. A plain `function`, no generic arrows:

```tsx
import type { ExtensionAPI } from '@dorkos/extension-api';

function HelloCard() {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--border)', borderRadius: '12px' }}>
      <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Hello</h3>
    </div>
  );
}

export function activate(api: ExtensionAPI): void {
  api.registerComponent('dashboard.sections', 'hello-card-section', HelloCard, { priority: 50 });
}
```

## 3. Test

```
test_extension(id: "hello-card")
```

```json
{
  "status": "ok",
  "contributions": { "dashboard.sections": 1, "right-panel": 0, "command-palette.items": 0 },
  "message": "Extension activated successfully. Registered 1 contribution(s)."
}
```

One dashboard section, as meant.

## 4. Check it started

`list_extensions`, your entry:

```json
{ "id": "hello-card", "status": "compiled", "bundleReady": true,
  "hasServerEntry": false, "serverStatus": "inactive" }
```

`serverStatus: inactive` is right here: there's no server code. For an app with
`server.ts`, anything but `active` means it didn't start; read `get_extension_errors`
and the server log.

## 5. Tell the person

> Built by {your name} from your request. **Hello Card** is a card on your dashboard
> that says hello. It reaches nothing outside your screen: no files, no network, no
> keys, no agent tools. It never posts or sends. You can turn it off in
> Settings → Extensions.
