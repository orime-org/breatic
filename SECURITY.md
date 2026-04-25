# Security Policy

> Breatic takes security seriously. If you've found a vulnerability, we
> want to hear from you — and we want to fix it quickly.

---

## Reporting a Vulnerability

**Please report security issues privately.** Do **not** open a public
GitHub issue, pull request, or discussion for vulnerabilities.

**Contact:** [**security@breatic.ai**](mailto:security@breatic.ai)

When possible, include:

- A short description of the issue (what, where, impact)
- Steps to reproduce, or a minimal proof-of-concept
- The affected version, branch, or commit hash
- Your preferred name or handle for acknowledgment (or a wish to stay
  anonymous)

If you would prefer GitHub's built-in private disclosure channel,
please use [**Private Vulnerability Reporting**](https://github.com/orime-org/breatic/security/advisories/new)
on this repository.

---

## Response Timeline

We commit to the following for reports that appear valid:

| Stage                     | Target time                    |
|---------------------------|--------------------------------|
| Acknowledgment of receipt | **Within 48 hours**            |
| Initial assessment        | **Within 7 days**              |
| Fix for critical issues   | **Within 30 days**             |
| Coordinated disclosure    | After fix is available         |

We'll keep you updated throughout and credit you (if you wish) when
the fix lands.

---

## Supported Versions

Breatic is under active development. Security fixes are applied to:

- The **`main` branch** (rolling release)
- The **latest tagged release**

Older tagged releases are not actively patched. Please upgrade to
receive security fixes.

---

## Scope

### ✅ In scope

- Source code in this repository (`orime-org/breatic`)
- Default configurations shipped with Breatic (Docker, deployment
  scripts, default settings)
- Security issues arising from Breatic's documented architecture,
  APIs, and data flows
- Breatic's **official hosted service** (breatic.ai) once publicly
  launched

### ❌ Out of scope

- **Third-party AI providers** (OpenAI, Anthropic, Google, etc.)
  integrated with Breatic — please report to the respective provider
- **User-deployed self-hosted instances** — report to the operator of
  that instance
- **User-generated content** produced through Breatic — governed by
  [LICENSE Clause 5](./LICENSE)
- **Social engineering** of Breatic contributors, maintainers, or
  team members
- **Physical attacks** on Orime, Inc. or any infrastructure
- **Denial-of-service / DDoS testing** against production systems
  (please do not run volumetric attacks)
- **Automated vulnerability scanner output** lacking a validated
  proof-of-concept — please verify manually before reporting

---

## Responsible Disclosure Guidelines

We ask that you:

1. **Give us reasonable time to patch before public disclosure** —
   we follow industry-standard coordinated disclosure, typically
   **90 days** from the date of acknowledged receipt, extensible by
   mutual agreement
2. **Do not exploit the vulnerability** beyond what's strictly
   necessary to confirm its existence
3. **Do not access, modify, or destroy** data that does not belong to
   you
4. **Do not pivot** into other systems or networks beyond Breatic
5. **Report through the channel above** — not public issues, Twitter,
   or other public channels

---

## Safe Harbor

Security research conducted in good faith under this policy is
welcomed and authorized by Orime, Inc.

Specifically, Orime, Inc. will:

- **Not pursue legal action** against researchers who act within this
  policy
- **Not consider such research** a violation of our terms of service
  or acceptable use policy
- Work with researchers to understand and resolve issues promptly

We ask researchers to act in good faith: follow the disclosure
guidelines above, and give us a reasonable opportunity to address the
issue before any public discussion.

If legal action is initiated against you by a third party for actions
taken in good faith under this policy, we will make it known that
your actions were authorized.

---

## Recognition

We're grateful to the research community. Reporters of valid,
previously-unknown vulnerabilities are:

- **Credited** (with your preferred name or handle, or anonymously if
  preferred) in release notes and a dedicated acknowledgments page
  once the fix is public
- **Thanked publicly** via social channels (with consent)

### Bug bounty

We **do not currently run a paid bug bounty program**. This may change
as Breatic grows; until then, recognition is our primary way of saying
thank you.

---

## Our Security Track Record

Breatic has undergone multiple rounds of **independent security audits**
as part of our pre-launch engineering discipline. Identified issues
are [continuously tracked in the open](./docs/internal/BUGS.md) —
**77+ findings as of April 2026**, with the count growing as new
reviews and reports come in. We believe transparent security
practices are a hallmark of a trustworthy AI platform.

---

## A Note on AI Platforms

Breatic is an AI-assisted content creation platform. Some categories
of "security" concerns are actually content or trust issues rather
than vulnerabilities:

- **Model output quality / hallucination** — not a security bug, but
  user feedback is welcome via support channels
- **Prompt injection targeting Breatic's own agents** — yes, this
  **is** a security issue (in scope)
- **Jailbreaking underlying AI models** — usually the underlying
  provider's responsibility, but report if the issue specifically
  leverages a Breatic feature to bypass safety
- **Generated content that violates policy** — content moderation
  issue, report via support channels, not here

When in doubt, err on the side of reporting via `security@breatic.ai`
— we'd rather triage a false positive than miss a real issue.

---

## Questions

For any questions about this policy or how to report, email
[security@breatic.ai](mailto:security@breatic.ai).

Thank you for helping keep Breatic and its users safe.

---

© 2026 Orime, Inc.
