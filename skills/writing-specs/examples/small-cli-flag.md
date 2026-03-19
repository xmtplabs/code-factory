# Design Doc: `--verbose` Flag for deploy-tool

## Summary

The `deploy-tool` CLI currently provides minimal output during deployments. This change adds a `--verbose` flag that enables detailed step-by-step logging.

## Project Goals & Non-Goals

**Goals:**
- Give operators visibility into each deployment step
- Default behavior remains unchanged (quiet output)

**Non-Goals:**
- Structured log output (JSON, etc.)
- Configurable log levels beyond on/off

## Context

- `src/cli.rs` — argument parsing
- `src/deploy.rs` — deployment pipeline

## System Design

Each deployment step already emits internal status messages. The `--verbose` flag pipes these to stderr instead of discarding them. No new logging infrastructure is needed.

```
deploy-tool --verbose deploy my-app
```

## Libraries & Utilities Required

None.

## Testing & Validation

- WHEN the `--verbose` flag is provided THE SYSTEM SHALL print a status line for each deployment step to stderr.
- WHEN no `--verbose` flag is provided THE SYSTEM SHALL suppress step-by-step output.
- THE SYSTEM SHALL NOT alter the exit code based on verbosity setting.
- WHEN `--verbose` is combined with `--help` THE SYSTEM SHALL display help text and exit without deploying.
