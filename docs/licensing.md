# Enterprise Licensing

> **Enterprise Edition feature.** Contact **hello@probelabs.com** for licensing.

This guide covers obtaining, installing, managing, and troubleshooting Visor Enterprise Edition licenses.

---

## Table of Contents

- [Overview](#overview)
- [Licensed Features](#licensed-features)
- [Obtaining a License](#obtaining-a-license)
- [Installing the License](#installing-the-license)
- [License Lookup Order](#license-lookup-order)
- [License Format](#license-format)
- [Grace Period](#grace-period)
- [Verifying Your License](#verifying-your-license)
- [Renewal](#renewal)
- [Rotation and Revocation](#rotation-and-revocation)
- [CI/CD Integration](#cicd-integration)
- [Air-Gapped Environments](#air-gapped-environments)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)

---

## Overview

Visor Enterprise Edition (EE) is a superset of the open-source version. All OSS functionality works identically without a license. Enterprise features are inert and silently disabled unless a valid license is present.

When a license is loaded:
1. Visor validates the cryptographic signature (EdDSA / Ed25519).
2. Checks the expiration date (with a 72-hour grace period).
3. Reads the `features` claim to determine which EE capabilities are active.
4. Caches the result for 5 minutes to avoid repeated validation.

---

## Licensed Features

| Feature String | Capability | Documentation |
|---------------|------------|---------------|
| `policy` | OPA policy engine (check gating, tool access, capability control) | [Enterprise Policy Engine](./enterprise-policy.md) |
| `scheduler-sql` | PostgreSQL, MySQL, and MSSQL scheduler backends | [Scheduler Storage](./scheduler-storage.md) |

Features not listed in the license JWT are disabled. The OSS SQLite scheduler and all other OSS features work without a license.

---

## Obtaining a License

### Trial License

Contact **hello@probelabs.com** with:
- Your organization name
- Expected number of Visor instances
- Which features you want to evaluate (`policy`, `scheduler-sql`, or both)

Trial licenses are typically issued for 30 days with all features enabled.

### Production License

Production licenses are issued per-organization and include:
- Organization name (`org` claim)
- Licensed features list
- Expiration date
- Unique subject identifier

Contact **hello@probelabs.com** or your account representative for production licensing.

---

## Installing the License

### Option 1: Environment Variable (recommended for CI/CD and containers)

```bash
export VISOR_LICENSE="eyJhbGciOiJFZERTQSIs..."
```

The value is the raw JWT string (no file path, no prefix).

### Option 2: Environment Variable Pointing to File

```bash
export VISOR_LICENSE_FILE="/etc/visor/license.jwt"
```

The file should contain only the raw JWT string.

### Option 3: Project-Level File

Place a file named `.visor-license` in your project root (alongside `.visor.yaml`):

```bash
echo "eyJhbGciOiJFZERTQSIs..." > .visor-license
```

### Option 4: User-Level File

Place the license in your home config directory:

```bash
mkdir -p ~/.config/visor
echo "eyJhbGciOiJFZERTQSIs..." > ~/.config/visor/.visor-license
```

---

## License Lookup Order

Visor checks for a license in this order, using the first one found:

1. `VISOR_LICENSE` environment variable (raw JWT)
2. `VISOR_LICENSE_FILE` environment variable (file path)
3. `.visor-license` in the current working directory
4. `~/.config/visor/.visor-license` in the user's home directory

---

## License Format

Licenses are Ed25519-signed JWTs (EdDSA algorithm) with the following payload:

```json
{
  "org": "Acme Corp",
  "features": ["policy", "scheduler-sql"],
  "exp": 1740000000,
  "iat": 1708464000,
  "sub": "org-acme-prod"
}
```

| Claim | Type | Description |
|-------|------|-------------|
| `org` | string | Organization name |
| `features` | string[] | Licensed feature strings |
| `exp` | number | Expiration timestamp (Unix seconds) |
| `iat` | number | Issue timestamp (Unix seconds) |
| `sub` | string | Subject identifier (unique per license) |

The signature is verified against Visor's embedded public key. Licenses cannot be forged or modified.

---

## Grace Period

When a license expires, Visor provides a **72-hour grace period**:

| State | Behavior |
|-------|----------|
| **Valid** | All licensed features work normally |
| **Expired < 72 hours** | Features continue working; warning logged at startup |
| **Expired > 72 hours** | Enterprise features silently disable; OSS features unaffected |

During the grace period, Visor logs:

```
[warn] Visor EE license expired. Grace period active (expires in Xh). Please renew.
```

---

## Verifying Your License

### Check at Startup

Run Visor with `--debug` to see license validation output:

```bash
visor --debug --config .visor.yaml --check all 2>&1 | grep -i license
```

With a valid license:
```
[debug] [License] Valid license for "Acme Corp" (features: policy, scheduler-sql, expires: 2026-06-01)
```

Without a license:
```
[debug] [License] No license found. Enterprise features disabled.
```

### Check Feature Availability

If a feature is used without a license, Visor logs a debug message and falls back to OSS behavior:

```
[debug] [Policy] Policy engine disabled (no license or feature not licensed)
```

---

## Renewal

### Before Expiration

1. Contact **hello@probelabs.com** or your account representative.
2. Provide your current `sub` claim (from your existing license) for continuity.
3. Receive a new JWT with an updated `exp` claim.
4. Replace the old license using any of the [installation methods](#installing-the-license).
5. Visor picks up the new license within 5 minutes (cache TTL) or on next restart.

### After Expiration (within grace period)

Same process as above. Enterprise features continue working during the 72-hour grace period.

### After Grace Period

Enterprise features are disabled but **no data is lost**. Once a new license is installed:
- Policy engine re-enables immediately.
- SQL scheduler backends reconnect automatically.
- All previously stored schedules and policies remain intact.

---

## Rotation and Revocation

### Rotating a License

To rotate to a new license (e.g., changing features or extending expiration):

1. Obtain the new license JWT.
2. Replace the old license (env var, file, or config file).
3. Restart Visor or wait up to 5 minutes for cache refresh.

Both old and new licenses can coexist briefly during rotation. Visor uses whichever it finds first in the lookup order.

### Revoking a License

To immediately revoke enterprise features:

```bash
# Remove from environment
unset VISOR_LICENSE
unset VISOR_LICENSE_FILE

# Remove from filesystem
rm .visor-license
rm ~/.config/visor/.visor-license
```

Restart Visor. Enterprise features will be silently disabled.

---

## CI/CD Integration

### GitHub Actions

```yaml
- name: Run Visor
  env:
    VISOR_LICENSE: ${{ secrets.VISOR_LICENSE }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: visor --config .visor.yaml --check all
```

### GitLab CI

```yaml
visor:
  image: node:20
  variables:
    VISOR_LICENSE: $VISOR_LICENSE
  script:
    - npm install -g @probelabs/visor@ee
    - visor --config .visor.yaml --check all
```

### Jenkins

```groovy
pipeline {
  environment {
    VISOR_LICENSE = credentials('visor-license')
  }
  stages {
    stage('Review') {
      steps {
        sh 'visor --config .visor.yaml --check all'
      }
    }
  }
}
```

### Kubernetes Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: visor-license
type: Opaque
stringData:
  VISOR_LICENSE: "eyJhbGciOiJFZERTQSIs..."
```

Reference in deployment:

```yaml
envFrom:
  - secretRef:
      name: visor-license
```

---

## Air-Gapped Environments

Visor licenses are validated entirely offline. No network calls are made during license validation. This makes Visor EE fully compatible with air-gapped and restricted network environments.

Requirements:
- The license JWT must be available via one of the [lookup methods](#license-lookup-order).
- The EE npm package (`@probelabs/visor@ee`) must be installed from a local registry or tarball.
- For OPA policies, pre-compile `.rego` to `.wasm` externally and reference the `.wasm` file directly.

---

## FAQ

**Q: What happens if I remove the license?**
A: Enterprise features silently disable. OSS features continue working. No data is lost. Schedules stored in PostgreSQL remain accessible once a license is restored.

**Q: Can I use the same license on multiple machines?**
A: Yes. Licenses are not node-locked. They are valid for the licensed organization across any number of instances.

**Q: Does Visor phone home?**
A: No. License validation is entirely offline using cryptographic signature verification. No telemetry or usage data is sent to Probelabs for licensing purposes.

**Q: What happens during a deploy if the license secret isn't set?**
A: Visor starts normally with OSS-only features. Enterprise features are disabled until the license is available.

**Q: Can I downgrade from EE to OSS?**
A: Yes. Replace `@probelabs/visor@ee` with `@probelabs/visor`. Remove the license. If you were using PostgreSQL, switch the scheduler config back to `driver: sqlite` and Visor will use the local SQLite database.

---

## Troubleshooting

### "No license found"

- Check the [lookup order](#license-lookup-order) and verify the license is accessible.
- For containers: ensure the env var or file mount is correctly configured.
- Run `visor --debug` to see which paths Visor checks.

### "License signature invalid"

- Ensure the JWT is not truncated or modified.
- Verify you're using a license issued by Probelabs (not a self-signed token).
- Check for trailing whitespace or newlines in the license string.

### "License expired"

- Check the `exp` claim: `echo "YOUR_JWT" | cut -d. -f2 | base64 -d 2>/dev/null | jq .exp`
- Contact **hello@probelabs.com** for renewal.
- The 72-hour grace period provides time to obtain a new license.

### "Feature not licensed"

- Check your license's `features` claim matches the feature you're using.
- `policy` is required for OPA policy engine.
- `scheduler-sql` is required for PostgreSQL/MySQL/MSSQL backends.

### License Not Picked Up After Update

- Visor caches license validation for 5 minutes. Wait or restart.
- If using `VISOR_LICENSE_FILE`, verify the file path hasn't changed.
- Check file permissions (must be readable by the Visor process).
