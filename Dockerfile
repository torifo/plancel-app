# Cloud Run image for plancel (Agentic AI Hackathon with Google Cloud entry).
#
# Official Deno image, pinned to the minor the repo is verified on (CI runs
# v2.9.x; see .github/workflows/verify.yml). Cloud Run injects PORT and the
# server reads it (src/deploy/main.ts), so nothing here fixes a port.
#
#   docker build -t plancel-gc .
#   docker run --rm -p 8080:8080 -e PORT=8080 -e PLANCEL_DEMO=1 \
#     -e PLANCEL_DEMO_PASSWORD=... -e PLANCEL_AGENT_TOKEN=... -e GEMINI_API_KEY plancel-gc
FROM denoland/deno:2.9.0

WORKDIR /app

# Dependencies first, so a source-only change reuses this layer. --frozen makes
# the build fail instead of silently re-resolving when deno.lock is stale.
COPY deno.json deno.lock ./
RUN deno install --frozen

# Only what the server reads at runtime: src/, web/ (UI + PWA shell) and the
# parser chain config. Tests and docs ride in src/ but are never loaded.
COPY parsers.config.json ./
COPY web ./web
COPY src ./src

# Compile the module graph into the image now so a cold start on Cloud Run does
# not spend its first seconds on it. The unstable flags match deno.json.
RUN deno cache --frozen --unstable-temporal --unstable-kv --unstable-cron src/deploy/main.ts

# The container filesystem is ephemeral: Deno KV is a local SQLite file under
# /tmp, which is writable on Cloud Run. Data lives as long as the instance
# (demo mode reseeds on boot).
ENV PLANCEL_KV_PATH=/tmp/plancel.kv

# Never run as root. The official image ships a `deno` user.
USER deno

# Same permissions as `deno task deploy:serve`, narrowed to the paths the server
# touches: its own files, and /tmp for the KV file.
CMD ["run", \
     "--allow-env", \
     "--allow-net", \
     "--allow-read=/app,/tmp", \
     "--allow-write=/tmp", \
     "--unstable-temporal", "--unstable-kv", "--unstable-cron", \
     "src/deploy/main.ts"]
