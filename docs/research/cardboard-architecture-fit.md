# How Footage could inform Cardboard's mobile intake

Research date: 30 October 2026. This explanation uses first-party Cardboard pages retrieved through websearch and the two prior research notes. It is not a product test or an audit of Cardboard's infrastructure.

Footage is an independent Android original-video intake prototype. No Cardboard integration is implemented. Native iOS uploads and background transfer in Footage are not implemented. The iOS interface is preview-only. See the [Footage README](../../README.md) for implementation and test limits. This research did not run the app, use a device, obtain credentials, contact Cardboard, or deploy anything.

## Six grounded facts

1. **The product turns footage or a prompt into an editable first cut.** Cardboard's homepage describes refinement through chat or a timeline, followed by sharing or export. Reliable media availability is therefore relevant to the product, but intake alone is not the editing product. Source: [homepage](https://www.cardboard.ai/), retrieved 30 October 2026.

2. **The mobile role explicitly includes large media and lifecycle reliability.** The official role asks for ownership of iOS and Android through app-store release, handling "4K, HDR, and huge files," and "Uploads that survive bad networks and the app going to the background." It asks the engineer to decide what the first mobile product should be and accepts Swift, Kotlin, or React Native experience. It does not prescribe an upload protocol or demand a copy of the desktop timeline. Preserving and verifying unchanged original bytes is Footage's proposed engineering response, not a quoted Cardboard requirement. Sources: [official mobile role](https://www.cardboard.ai/careers/product-engineer-mobile) and [company's Ashby listing](https://jobs.ashbyhq.com/cardboard/a18a5b6c-8b4a-4418-be14-55235744313f), retrieved 30 October 2026.

3. **Cardboard already publicly describes background imports in its browser product.** Its 20 July 2026 changelog says uploads, analysis, and transcription keep running when the tab is backgrounded. This is not evidence about native mobile Home, screen lock, process death, or force-stop behavior. Pitch mobile lifecycle work as a relevant engineering problem, not a repair for a confirmed Cardboard defect. Source: [changelog, release 34](https://www.cardboard.ai/changelog#34), retrieved 30 October 2026.

4. **Local Mac editing and cloud processing must be distinguished.** The current Mac page says phone clips and camera files need "No upload." The 28 September 2026 release says footage stays on the Mac and is edited there. The 6 April release describes cloud processing and background preparation of large media. The homepage FAQ snapshot retained on 29 October says Mac editing and export are local, browser editing and export are in the cloud, and transcription and generation use the cloud on both. However, the live first-party `llms.txt` also describes browser-native local rendering and browser or server export. These public descriptions differ in scope and do not establish one universal execution path. Do not draw "all Cardboard editing requires uploading originals" or infer the exact browser pipeline. Sources: [Mac product page](https://www.cardboard.ai/desktop), [September release](https://www.cardboard.ai/changelog#44), [April release](https://www.cardboard.ai/changelog#19), and [machine-readable product description](https://www.cardboard.ai/llms.txt), retrieved 30 October 2026. The full FAQ wording is preserved in [the 29 October homepage snapshot](sources/cardboard-home.txt) and discussed in [the earlier company research](cardboard-company-role.md).

5. **Large-asset availability is a stated collaboration problem.** Cardboard's hard-problems page distinguishes source media from timeline and playback state. It names preprocessing, compression, and selective sync as areas of work. This supports discussing an asset-availability boundary. It does not reveal deployed services, queues, storage, protocols, or client synchronization algorithms. That page also discusses client-side processing, so it should not override platform-specific product descriptions. Source: [hard problems, Collaboration](https://www.cardboard.ai/hard-problems), retrieved 30 October 2026.

6. **Phone access through chat is different from a standalone mobile editor.** The homepage FAQ says phones and tablets are not supported, and the mobile role says there is no mobile app yet. The current ChatGPT and Claude product page separately advertises editing from a phone through those apps, with attached clips or an upload box saved to the user's Cardboard account. These statements describe different entry points. Do not say Cardboard has no phone workflow, or imply Footage implements its chat connection. Sources: [homepage](https://www.cardboard.ai/), [mobile role](https://www.cardboard.ai/careers/product-engineer-mobile), and [ChatGPT and Claude product page](https://www.cardboard.ai/mcp), retrieved 30 October 2026.

## Hypothetical opportunity, not Cardboard's existing architecture

The useful proposal is a clear contract between original-media receipt and editing readiness. The following is a candidate design to discuss, not a statement about Cardboard's stack or missing capabilities.

1. A person confirms a phone clip for transfer. A native transfer owner retains durable job identity, reconciles receiver-confirmed progress after interruption, and reports waiting or retry states without claiming success.
2. A receiver accepts the original and checks its full length and content hash before issuing a receipt. This establishes byte integrity against the selected source. It does not establish correct decoding, HDR fidelity, or editorial quality.
3. Only a verified original becomes eligible for this proposed downstream preparation flow. Independent work produces an editing proxy, thumbnails, and a transcript. Retain each derivative's relationship to the original and report its readiness separately. This sequencing is a conservative proposal for this experiment, not a claim that all editors must wait for full original upload.
4. An editing workspace can discover the asset and its available derivatives. Lightweight assets could support review and editing while the retained original remains available for later high-quality output. The exact publication and import mechanism would require agreement with Cardboard. None has been implemented or verified.

Keep these states distinct in an explanation or diagram:

- Transfer progress describes bytes confirmed by the receiver.
- Original verified describes a matching complete object and receipt.
- Proxy ready, thumbnails ready, and transcript ready each describe a separate derivative result.
- Available in an editing workspace requires a separate handoff acknowledgement.

A receipt must not silently mean "ready to edit." A failed transcript must not turn an intact original into a failed upload. After a preparation retry, the proposed design would reuse the verified original rather than resend it. These are opportunities for the independent design, not reports of Cardboard bugs.

### Cloud intake and local editing are alternative destinations

For a proposed cloud workflow, a verified original could feed preparation services, then an asset catalog that an editing workspace can consume. No specific Cardboard storage provider, API, queue, or service boundary is known from this research.

For a local Mac workflow, a future trusted handoff could deliver an original to the user's computer for local preparation and import. This would be a separate design, with consent, discovery, authorization, and availability questions still open. A cloud upload should not become a mandatory prerequisite for the local workflow that Cardboard markets today.

Useful experiments would measure time to verified original and time to usable derivatives separately. They could compare preparation location and proxy size on consented footage. Do not claim faster imports, lower cloud costs, or better reliability without a defined baseline and observed results.

## Diagram briefs for the architecture explanation

Use a legend that separates implemented Footage components, proposed work, and external product context. A named external product is not an implemented connection.

- **Original intake and the proposed next stage.** Draw the Android intake and Footage receiver as the independent prototype. Show an explicit receipt boundary. After it, draw dashed boxes for proxy preparation, thumbnails, transcripts, and a generic editing workspace. Label the entire extension "Hypothetical, not implemented." If Cardboard is named as the possible workspace, put "No integration" next to the dashed handoff. Keep iOS outside the implemented upload path and label it "Preview only; native upload not implemented."
- **Two possible destinations.** Contrast a hypothetical phone-to-cloud intake path with a hypothetical phone-to-Mac handoff. Put Cardboard's published cloud and local product context beside the paths, not inside invented backend boxes. State that the local path does not require a cloud-first upload. Neither handoff is implemented.

These are briefs for Excalidraw, not generated diagram files. The parent architecture explanation should verify Footage's implemented boxes against source and evidence before drawing them.

## Pitch boundaries

A defensible pitch is: "Footage explores reliable original-video handoff on Android, including honest completion and recovery states. It is relevant to the large-file and background-upload problems in your mobile role. A possible next experiment is to connect a verified original to independently tracked editing derivatives."

Avoid these claims:

- Cardboard's current uploads are broken, block all editing, or lack integrity checks.
- Cardboard uses Footage's protocol, storage, native schedulers, or capability model.
- A public product page documents an intake API suitable for this prototype.
- SHA-256 verification solves Cardboard's editorial verification problem. Its hard-problems page includes pacing, brand fit, story, and audiovisual quality.
- Footage supports native iOS uploads, implements an editor, is production-ready, or has a Cardboard partnership.
- Historical forum complaints establish a current upload defect. The prior [public-voices note](cardboard-public-voices.md) explicitly warns against that inference.

The official mobile role also asks for shipped apps and end-to-end ownership. This prototype can supply focused engineering evidence, not establish app-store experience or eligibility by itself.

## Retrieval and evidence limits

The new public research used websearch with live crawling preferred on 30 October 2026. Some results expose selected page passages rather than the complete document. The FAQ's full processing statement comes from the clearly dated prior snapshot, not a newly reproduced product test. All external product claims above cite company-owned pages or the company's own job listing. No third-party commentary is used as new evidence.

The earlier notes provide context and provenance, not permission to promote historical claims into current architecture facts. Internal APIs, implementation details, production failure rates, current native-mobile progress, and integration feasibility remain unknown.
