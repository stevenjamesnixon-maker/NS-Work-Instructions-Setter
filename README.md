# NS Work Instructions Setter

SuiteScript 2.1 for the NetSuite work-instruction routing feature: a picker that chooses a work
instruction **before** the Task record is created, so the Task opens on the right form with its
type, assignee, priority and due date already set — and so the work instruction type is stored in
a real, searchable field rather than implied by the custom form.

## Canonical reference

**[`docs/context.md`](docs/context.md) is the single source of truth for this project.** Read it
before changing anything. It records the design constraints, the NetSuite traps that shaped them,
the audit log keys, the deployment sequence and the open items.

If this README and `docs/context.md` disagree, the context document wins. If either disagrees with
the code, the code wins — and the document gets fixed in the same PR.

## Layout

```
src/FileCabinet/SuiteScripts/WorkInstructions/
    lib/                 shared modules — uploaded, but no script record needed
docs/context.md          canonical project context
```

The `src/FileCabinet/...` path mirrors the NetSuite File Cabinet exactly. There is no SDF project;
the path exists so that a reader can tell where each file belongs in the File Cabinet without
asking, and because the relative imports between scripts only resolve if the tree is preserved.

## Conventions

Script file names carry the entry-point type, so it shows up in PR file lists:

| Pattern | Example |
|---|---|
| `wi_ue_<purpose>.js` | `wi_ue_opportunity_button.js` |
| `wi_sl_<purpose>.js` | `wi_sl_picker.js` |
| `wi_cs_<purpose>.js` | `wi_cs_picker.js` |
| `lib/wi_lib_<purpose>.js` | `lib/wi_lib_config.js` |

Script records use `customscript_wi_<type>_<purpose>` and deployments
`customdeploy_wi_<type>_<purpose>`.

Every `log.audit` and `log.error` title begins `WI_` — one string to grep the execution log for.

Each script carries a `VERSION` constant and a matching JSDoc `@version` header. Semver.

## Deployment

**Manual File Cabinet upload. Steve deploys — nobody else, and no automated deploy exists.**
Upload `lib/wi_lib_config.js` first; every other script fails at load time without it. Full
sequence in [`docs/context.md` §8](docs/context.md).

## Two rules for contributors

1. **Never commit internal IDs.** Numeric record IDs, custom form IDs and File Cabinet folder IDs
   differ between Sandbox and Production and must live on the Work Instruction Type record in
   NetSuite, never in code. Script IDs — `customrecord_*`, `custevent_*`, `customscript_*` and the
   rest — are stable across environments and are fine to commit. The distinction is set out in
   [`docs/context.md` §3](docs/context.md).

2. **Never merge without Steve's explicit instruction.** Work goes on a branch with a PR and
   waits. Steve merges; Steve deploys.
