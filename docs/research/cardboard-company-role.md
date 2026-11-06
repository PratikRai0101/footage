# Cardboard company, product, and mobile application research

Research date: 29 October 2026. This is public-source research, not a product test or an application submission.

## What Cardboard is

Cardboard is an agentic video editor. Users provide footage, a prompt, or both, get an editable first cut, then refine it through chat or a timeline. Its [YC profile](https://www.ycombinator.com/companies/cardboard) names growth and marketing teams and serious creators as its target customers. The [current product site](https://www.cardboard.ai/) also promotes generated media, motion graphics, captions, reference-based edits, web-sourced B-roll, sharing, and exports to other editors.

The useful business interpretation is faster, repeatable video production, not an AI model that generates every frame from nothing. This interpretation follows the product workflow and stated audience. It is not a verified revenue model or customer segmentation study.

Current platform claims on the [homepage FAQ](https://www.cardboard.ai/):

- Any computer with Chrome, plus an Apple Silicon Mac app.
- Phones and tablets are not supported yet. Browsing recipes on a phone is not the same as mobile-editor support.
- The Mac app edits and exports locally. Browser editing and exports happen in the cloud.
- AI transcription and generation use the cloud on both platforms.
- Agents can use the Mac app through a CLI or MCP server.

These are company statements. No account was created, no paid plan was purchased, and no editor or integration was tested in this research.

## Founders and the visible company timeline

[YC](https://www.ycombinator.com/companies/cardboard) names Saksham Aggarwal as founder/CEO and Ishan Sharma as founder/CTO. Saksham previously cofounded Iterate AI and studied computer science at BITS Pilani. Ishan previously spent about 4.5 years at HackerRank on performance-sensitive web products. Their biographies describe prior achievements, not Cardboard usage metrics.

The following dates describe public milestones, not audited growth:

- **1 November 2025:** Saksham says he started building with Ishan, his school friend. The source is the company's [27 December announcement resharing his account](https://www.linkedin.com/posts/cardboardinc_hello-world-activity-7410606110430269440-B4Ns).
- **9 November 2025:** The [company changelog](https://www.cardboard.ai/changelog) dates its initial release here. This can coexist with later public launches. It does not prove general public availability on that date.
- **27 December 2025:** The LinkedIn announcement reports acceptance into YC Winter 2026 and invites design partners.
- **26 February 2026:** The founders introduce Cardboard on [Launch HN](https://news.ycombinator.com/item?id=47170174).
- **11 March 2026:** The [Product Hunt launch](https://www.producthunt.com/products/cardboard-3) adds a public launch discussion. Maker comments began on 10 March.
- **6 April 2026:** The changelog announces cloud processing and background preparation for large media.
- **20 July 2026:** The changelog says uploads, analysis, and transcription continue when a browser tab is backgrounded. This is a browser claim, not evidence for Android Home, screen lock, or process death.
- **28 September 2026:** The changelog announces the Mac app, local editing, and integration with users' own agents.
- **13 October 2026:** Recipes are announced as reusable edits users can remix with their footage.
- **20 October 2026:** The changelog describes export validation before declaring completion. Its speed and resource figures are company-reported, not reproduced here.
- **26 October 2026:** The changelog announces editing through ChatGPT and Claude.
- **29 October research snapshot:** YC lists a team size of eight. The official Ashby board lists seven openings, including mobile. These directories can lag actual staffing and hiring.

The visible pattern is rapid product expansion and a small hiring team. There is no independently verified revenue, retention, paying-customer trajectory, or date of product-market fit in this research. Founder social reach, LinkedIn followers, launch votes, and terabytes processed are not substitutes.

### Funding limits

YC participation is supported by [YC's own directory](https://www.ycombinator.com/companies/cardboard). The [mobile role](https://www.cardboard.ai/careers/product-engineer-mobile) says Cardboard is backed by a tier-one global fund, YC, and founders of billion-dollar companies, but does not name them all or give a round size.

Third-party directories surfaced conflicting totals, including $500,000 and about $2.1 million. No primary round announcement confirming the total was found in this pass. Do not repeat a total or name an additional fund as an established fact. Search-engine access was rate-limited during some follow-up queries, so this is an evidence limit, not proof that no announcement exists.

## What the public voices tell us

The detailed source audit is [Cardboard public voices](cardboard-public-voices.md). It separates original posts, mirrors, search excerpts, and interpretation.

The strongest findings for this application are:

- [Saksham's LinkedIn culture post](https://www.linkedin.com/posts/sakshamagg27_cardboard-is-like-hogwarts-for-nerds-everyone-activity-7506363977677819904-3HbE) emphasizes intellectual curiosity and high agency. [Ishan's portfolio](https://ishandeveloper.com/) emphasizes motion, timing, and how products feel. These are founder preferences, not an independent workplace review.
- [A named HN customer](https://news.ycombinator.com/item?id=47171401) reports using Cardboard for feature-update videos. [Another tester](https://news.ycombinator.com/item?id=47177462) reports a good sample-project result but difficulty finding undo.
- [A touch-screen complaint](https://news.ycombinator.com/item?id=47171909) receives an [acknowledgement and claimed fix from Ishan](https://news.ycombinator.com/item?id=47172184). It is historical evidence of one issue, not proof that current touch behavior is broken.
- [An HN commenter asks to see raw inputs](https://news.ycombinator.com/item?id=47173306), rather than only polished output. This supports an application demo with inspectable inputs and results.
- Reddit evidence is sparse and partly promotional. Retrieved excerpts include claimed novice use, lightweight comparisons, and skepticism about promotion. Direct thread retrieval failed. It would be misleading to call Reddit sentiment broadly positive or negative.
- A recent [X complaint about B-roll and credits](https://x.com/ArpitGuptaJii/status/2113924703186456818), accessible through a public mirror, receives a founder response. It is not evidence of mobile-transfer failure.
- No substantive, independent employee account of engineering conditions was recovered. Founder praise and recruitment replies cannot establish working conditions.

Do not manufacture consensus from these examples. Do not use old comments as current bug reports without reproducing the issue.

## Product architecture claims changed over time

The [February HN launch](https://news.ycombinator.com/item?id=47170174) describes client-side rendering. A [March maker reply](https://www.producthunt.com/products/cardboard-3?comment=5200400) says full-footage upload was for collaboration and cloud synchronization rather than a prerequisite to editing.

The current homepage says the browser uses cloud processing and the Mac app edits locally. The April and September changelog entries provide context for this evolution. The hard-problems page still discusses client-side processing in collaboration.

Use the current platform-specific FAQ when describing today's product, and date historical statements. None of these public descriptions is an audit of internal architecture. Footage must not claim to fix a confirmed upload-before-editing bottleneck or integrate with undocumented Cardboard endpoints.

## What the mobile role actually asks for

Sources: [official role](https://www.cardboard.ai/careers/product-engineer-mobile), [official Ashby job](https://jobs.ashbyhq.com/cardboard/a18a5b6c-8b4a-4418-be14-55235744313f), and [public job-board API](https://api.ashbyhq.com/posting-api/job-board/cardboard?includeCompensation=true).

The public API lists the role as published on 3 October 2026, listed, full-time, on-site in Bengaluru. No application deadline or compensation amount was present in the retrieved metadata.

The role calls for:

- Owning iOS and Android from architecture through app stores.
- Deciding what the first mobile product should be, not merely reproducing a desktop timeline.
- Handling real 4K, HDR, and large phone files.
- Uploads that tolerate poor networks and backgrounding.
- Shipped mobile apps used by real people, interaction craft, user contact, and checking outcomes.
- Strong Swift, Kotlin, or React Native engineering. No single stack is mandatory.
- Daily use of AI agents with the engineer retaining product judgment.

**Implication:** Footage can provide concentrated evidence for media intake, lifecycle boundaries, recovery, and taste. It cannot replace an existing shipping record or prove full mobile-product ownership, store release, iOS reliability, or senior-level experience in two days.

### Eligibility is unresolved

[Saksham's 24 October X hiring post](https://x.com/sxmawl/status/2113846865620091134) says "only for senior roles." Native X was inaccessible; the research note records its public mirror and corroborating reproduction. [YC jobs](https://www.ycombinator.com/companies/cardboard/jobs) still allow new graduates for some other engineering roles. The mobile listing itself does not specify a numerical experience minimum, but expects shipped apps and broad ownership.

Treat the role as a senior-leaning stretch. Graduation in June 2027 and availability from December 2026 must be stated separately. The user must clarify whether December means full-time on-site work, an internship, or another arrangement compatible with study. Do not invent years of professional experience or imply an exception was approved. Use the published application channel. This research contacted no one.

## The actual application form

Source: [the supplied application URL](https://jobs.ashbyhq.com/cardboard/a18a5b6c-8b4a-4418-be14-55235744313f/application), retrieved on 29 October 2026.

The initial HTML contained job metadata but not the questions. The site's public JavaScript includes a read-only GraphQL query named `ApiJobPosting`. That exact query returned the rendered application schema. No submission mutation, candidate-data write, resume upload, or contact occurred.

Required fields:

1. Name.
2. Email.
3. LinkedIn.
4. GitHub.
5. Your personal website.
6. "Years of Experience  and Graduation Year", with the example "3 YOE (2023 grad)".
7. "One product or piece of software you think is exceptionally well built and one sentence on why?"
8. "Something you shipped end to end that you're proud of?"

Optional fields:

- Resume.
- "Optional: If you'd like, record and send us a quick video : )", a URL field.

There were no additional survey forms in this retrieval. Forms may change. The example is not an explicit minimum-experience rule. Required questions must be answered from the user's actual history and opinions.

### What to prepare for those questions

- Put established shipped apps and actual users first. Use Footage as additional, role-specific proof, not an invented production deployment.
- Link a clean repository from GitHub. Its first screen should explain the independent demo, show the recording, and link the evidence and setup.
- Use an existing personal site to present the project when possible. Do not divert the two-day build into a new portfolio platform.
- Choose a product the user genuinely uses for the taste question. Name one observable interaction and its benefit in one sentence. Do not select a fashionable product or compliment Cardboard without first-hand experience.
- Keep the optional video about three minutes. Show a real clip, a live interruption, reconciled progress, and the receiving-side receipt. Include the device, limits, and the user's decisions.
- State graduation and availability plainly. Explain relevant professional work, internships, and personal projects without counting them interchangeably.

## How the hard problems constrain the demo

The [hard-problems page](https://www.cardboard.ai/hard-problems) names ten areas: browser NLE performance, collaboration, multimodal understanding, context, predicting actions, style references, motion graphics, memory, verification, and version control.

Footage directly concerns large media movement and the mobile role's explicit lifecycle requirements. It contributes a prerequisite to asset availability for collaboration. It does not implement collaborative editing or solve every part of that hard problem.

File length and SHA-256 checks verify byte integrity only. They do not solve Cardboard's problem of evaluating edit quality, pacing, brand fit, audio sync, or story. Keep those claims separate even though both use the word "verification."

The proposed differentiator is a credible completion contract: sent bytes are not confirmed bytes, confirmed bytes are not a verified receipt, and a receipt does not imply the clip has been edited. Good UX makes those boundaries understandable without making the user read protocol details.

## Consequences for the build

Keep the agreed Android-first architecture and selected screening-room design. Resolve preparation after explicit upload confirmation. Build the transfer feasibility spike before polish. Test on the physical phone, retain original bytes, show recoverable errors, and include receiving-side proof.

Do not add AI chat, an editing timeline, camera capture, multiple uploads, authentication flows, or unofficial integration to appear closer to the whole company. The current role is broad. A precise, working subset is stronger evidence than a large untested imitation.

The updated [authoritative MVP plan](../../../Cardboard_MVP_Plan.md) contains the implementation contract and staged build order. Nothing in this research is a measured transfer result.

## Retrieval record

Local evidence is under `sources/` next to this note:

- `cardboard-home.html` and `.txt`.
- `hard-problems.html` and `.txt`.
- `mobile-role.html` and `.txt`.
- `changelog.html` and `.txt`.
- `yc-company.html` and `.txt`.
- `founding-announcement.html` and `.txt`.
- `ashby-postings.json`.
- `ashby-application.html`, `ashby-appdata.json`, `ashby-form-query.graphql`, `ashby-form-response.json`, and `ashby-application-fields.json`.

The query and raw response allow the form findings to be checked without assuming that a search excerpt contains the application questions. Raw public HTML includes tracking identifiers and public site configuration. These are research snapshots, not application assets or packages to bundle into the app.
