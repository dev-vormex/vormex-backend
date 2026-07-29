# Controlled encryption-key rotation

This runbook rotates protected Vormex backend data without a flag day and without
printing keys, plaintext, ciphertext, database URLs, or record identifiers.

## Protected data covered

- `User.githubAccessToken`
- `User.phoneEncrypted`
- `User.adminTwoFactorSecret`, including historical plaintext values
- encrypted identity-evidence `.bin` files under `IDENTITY_EVIDENCE_DIR`

The Neon backup branch protects database values only. Identity-evidence files are
outside Neon and must have their own backup before they are rewritten.

## Key behavior

- `ENCRYPTION_KEY` is the active key. Every new write uses this key and AES-256-GCM.
- `ENCRYPTION_KEY_PREVIOUS` is an optional, temporary read-only fallback.
- Authenticated values try the active key and then the previous key.
- Historical AES-CBC values try the previous key first during a dual-key rotation,
  because CBC has no authentication tag and all new writes use AES-GCM.
- The two variables must be distinct 64-character hexadecimal keys.

Do not place either key in command arguments, logs, tickets, chat, source control,
or migration output. Store them only in the approved secret manager and Render
secret environment variables.

## Migration command

The compiled operator command is:

```sh
npm run encryption:rotate -- --dry-run
```

It reads `DATABASE_URL`, `ENCRYPTION_KEY`, `ENCRYPTION_KEY_PREVIOUS`, and
`IDENTITY_EVIDENCE_DIR` from the process environment. It does not accept a
database URL or key as a command-line argument.

Modes:

- `--dry-run` is the default. It reads and classifies protected values but writes
  nothing.
- `--apply` performs compare-and-swap database updates and atomic evidence-file
  replacement. It requires `--confirm=dual-key-rotation`.
- `--verify` reads everything again and fails if any value is unreadable, uses the
  previous key, uses the legacy format, or remains plaintext.

Output contains aggregate counts only. No record IDs or protected values are
printed.

## Production procedure

Production actions require explicit approval immediately before execution.

1. Deploy the dual-key-capable code while the existing `ENCRYPTION_KEY` is still
   active and `ENCRYPTION_KEY_PREVIOUS` is unset. Confirm API, worker, and scheduler
   instances are all running the dual-key build.
2. Generate a new 32-byte random key directly in the approved secret-management
   workflow. Do not expose it in a terminal transcript.
3. In one coordinated Render environment update, set the existing key as
   `ENCRYPTION_KEY_PREVIOUS` and the new key as `ENCRYPTION_KEY`. Redeploy every
   backend process. Do not remove the previous key.
4. Confirm readiness and basic authenticated reads. Pause identity-evidence upload
   and replacement during the migration window. If this fails, follow the
   pre-migration rollback below and do not run apply.
5. Run the dry-run from a Render shell using the service environment:

   ```sh
   npm run encryption:rotate -- --dry-run --batch-size=100
   ```

6. If dry-run reports zero invalid values, choose a secure backup directory on a
   persistent disk outside `IDENTITY_EVIDENCE_DIR`, and copy that backup off-host
   according to the retention policy. Run apply:

   ```sh
   npm run encryption:rotate -- --apply --batch-size=100 \
     --confirm=dual-key-rotation \
     --evidence-backup-dir=/persistent/secure/encryption-rotation-backups/2026-07-29
   ```

   If there are no evidence files, the backup argument may be omitted. Apply runs
   its own preflight and verification pass. It is safe to rerun after interruption.
7. Run an independent verification pass:

   ```sh
   npm run encryption:rotate -- --verify --batch-size=100
   ```

8. Validate GitHub integration reads, admin 2FA verification, phone-protected
   account flows, and authorized identity-evidence retrieval. Ensure logs contain
   neither secrets nor decrypted data.
9. Keep both keys during the agreed observation window. Investigate any decryption
   error before continuing.
10. With separate approval, remove only `ENCRYPTION_KEY_PREVIOUS`, redeploy every
    backend process, and run `--verify` again. The active key remains unchanged.

## Idempotency and concurrency

- Values already encrypted with the active key and AES-GCM are skipped.
- Legacy, plaintext-admin-2FA, and previous-key values are re-encrypted once.
- Each database update includes the original ciphertext in its `WHERE` condition,
  so a concurrent application write cannot be overwritten.
- Every replacement is decrypted and compared in memory before persistence.
- Evidence files are copied to the backup directory, written to a same-directory
  temporary file, synced, atomically renamed, and read back for verification.
- Rerunning apply skips completed values and accepts an identical existing evidence
  backup; a conflicting backup causes failure.

## Rollback plan

If deployment or variable switching fails before apply:

1. Keep both keys available.
2. Restore the old key as `ENCRYPTION_KEY` and the new key as
   `ENCRYPTION_KEY_PREVIOUS` in one coordinated Render update.
3. Redeploy all backend processes and validate protected reads.

If apply is interrupted or verification finds pending values:

1. Do not remove either key and do not restore the Neon branch.
2. Resolve the operational cause and rerun the same apply command with the same
   evidence backup directory. The migration is idempotent.
3. Run verification again.

If a full rollback to the old key is required after apply:

1. Swap the roles so the old key is active and the new key is the previous fallback.
   This immediately keeps both old and newly written values readable.
2. Run dry-run, apply, and verify again. The same migration code will re-encrypt
   values from the new key back to the old active key. Use a new evidence backup
   directory for this reverse pass.
3. Remove the new fallback only after a clean verification and observation window.

Use the Neon backup branch only as a last-resort database restore because it does
not contain writes made after the snapshot. Restoring Neon also does not restore
identity-evidence files; use the separately retained evidence backup for those.
Never delete either key while any rollback or forensic validation is in progress.
