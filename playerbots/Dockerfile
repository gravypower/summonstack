# ─────────────────────────────────────────────────────────────────────────────
# SummonStack — Playerbots Worldserver
#
# Multi-stage build:
#   builder     → clones mod-playerbots/azerothcore-wotlk, copies module SQL
#                 into the custom SQL directories, then compiles
#   worldserver → runtime image (binary + SQL source for self-import on boot)
#
# Database import strategy (from mod-playerbots official Docker guide):
#   The mod-playerbots SQL files are copied into data/sql/custom/ during build
#   so they are picked up by the worldserver's built-in Updates.AutoSetup on
#   first start.  No separate dbimport binary is required.
#
# Build args:
#   ACORE_BRANCH   branch of mod-playerbots/azerothcore-wotlk  (default: Playerbot)
#   PB_BRANCH      branch of mod-playerbots/mod-playerbots      (default: master)
#   BUILD_JOBS     parallel jobs passed to cmake --build        (default: nproc)
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS builder

ARG ACORE_BRANCH=Playerbot
ARG PB_BRANCH=master
ARG BUILD_JOBS

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git cmake make clang \
        libssl-dev default-libmysqlclient-dev libreadline-dev \
        zlib1g-dev libbz2-dev libncurses-dev \
        libboost-system-dev libboost-filesystem-dev libboost-thread-dev \
        libboost-program-options-dev libboost-iostreams-dev libboost-regex-dev \
    && rm -rf /var/lib/apt/lists/*

# Clone AzerothCore playerbots fork
RUN git clone --depth=1 \
        --branch="${ACORE_BRANCH}" \
        https://github.com/mod-playerbots/azerothcore-wotlk.git \
        /azerothcore

# Clone mod-playerbots into the modules directory
RUN git clone --depth=1 \
        --branch="${PB_BRANCH}" \
        https://github.com/mod-playerbots/mod-playerbots.git \
        /azerothcore/modules/mod-playerbots

# Copy module SQL into AzerothCore's custom SQL directories so they are
# included when the worldserver self-populates the databases on first start.
# Per the mod-playerbots Docker Installation Guide:
#   cp modules/mod-playerbots/sql/characters/base/*.sql data/sql/custom/db_characters/
#   cp modules/mod-playerbots/sql/world/base/*.sql      data/sql/custom/db_world/
RUN mkdir -p /azerothcore/data/sql/custom/db_characters \
             /azerothcore/data/sql/custom/db_world && \
    find /azerothcore/modules/mod-playerbots/sql/characters/base -name '*.sql' \
         -exec cp {} /azerothcore/data/sql/custom/db_characters/ \; 2>/dev/null || true && \
    find /azerothcore/modules/mod-playerbots/sql/world/base -name '*.sql' \
         -exec cp {} /azerothcore/data/sql/custom/db_world/ \; 2>/dev/null || true

WORKDIR /azerothcore

# Configure.
# -DWITH_WARNINGS=0 suppresses thousands of cosmetic warnings from mod-playerbots,
# substantially speeding up compilation output (user tip).
# -DTOOLS_BUILD=none skips map-extraction tools (client data already extracted).
RUN cmake . -B build \
        -DCMAKE_BUILD_TYPE=RelWithDebInfo \
        -DCMAKE_C_COMPILER=clang \
        -DCMAKE_CXX_COMPILER=clang++ \
        -DWITH_WARNINGS=0 \
        -DTOOLS_BUILD=none \
        -DSCRIPTS=static \
        -DMODULES=static

# Compile — takes 30-60 minutes on first build; cached by Docker after that.
RUN cmake --build build -j${BUILD_JOBS:-$(nproc)} \
    && cmake --install build --prefix /azerothcore/env/dist

# ── Stage 2: Worldserver runtime ─────────────────────────────────────────────
FROM ubuntu:22.04 AS worldserver

ENV DEBIAN_FRONTEND=noninteractive

# Runtime libraries — versions match Ubuntu 22.04 build-time packages.
RUN apt-get update && apt-get install -y --no-install-recommends \
        default-mysql-client libssl3 libmysqlclient21 libreadline8 libncurses6 \
        libboost-system1.74.0 libboost-filesystem1.74.0 libboost-thread1.74.0 \
        libboost-program-options1.74.0 libboost-iostreams1.74.0 libboost-regex1.74.0 \
        libboost-atomic1.74.0 libboost-chrono1.74.0 libboost-date-time1.74.0 \
    && rm -rf /var/lib/apt/lists/*

# Compiled binaries and config templates
COPY --from=builder /azerothcore/env/dist /azerothcore/env/dist

# SQL source tree — worldserver reads this at startup to self-populate DBs.
# The custom/ subdirectories now contain the mod-playerbots SQL files.
COPY --from=builder /azerothcore/data    /azerothcore/data
COPY --from=builder /azerothcore/modules /azerothcore/modules

WORKDIR /azerothcore

COPY entrypoint-worldserver.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 8085 — game traffic  |  7878 — SOAP API (internal only, host-bound in compose)
EXPOSE 8085 7878

ENTRYPOINT ["/entrypoint.sh"]
