# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- Only IAM principals with the stack's invoke policy can call the agent.
- Tools take the customer ID from the signed request, so a prompt can't widen what the model reads.
- The runtime role reaches one model, one table and one memory, with the fewest actions that work.
- Callers and the model get a generic message in place of AWS error text.
