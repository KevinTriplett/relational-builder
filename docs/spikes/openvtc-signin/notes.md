* npm run build passes. There are only warnings about chunk sizes.
* npm run lint shows 21 problems (20 errors, 1 warning) that are already on main. Write that number down so later lint errors don't get blamed on the spike.
* The build also rewrites a timestamp in public/knowledge/index.json. I reverted it, so your working tree is clean apart from docs/spikes/. That will happen every time you build, so don't commit it.
* When building locally, I leave the project page, go to "Your projects", I expect to click on my open project and be taken to that page. Instead, nothing about the project is clickable despite it looking like a button, I have to click the app title in the topnav.
* I need instructions on how to spin up the I agent

Run after Spike v2 Phase 3 starts:

cd ../relational-builder-impl
ANTHROPIC_BASE_URL=http://localhost:11434 \
ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" \
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.8-impl-128k \
ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.8-impl-128k \
ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.8-impl-128k \
CLAUDE_CODE_SUBAGENT_MODEL=qwen3.8-impl-128k \
CLAUDE_CODE_AUTO_COMPACT_WINDOW=131072 \
claude --model qwen3.8-impl-128k \
  --disallowedTools "Read(./tests/app-trust-tasks/COVERAGE.md)"

Then tell it, "Read docs/spikes/openvtc-signin/BRIEF-I.md and carry it out."

