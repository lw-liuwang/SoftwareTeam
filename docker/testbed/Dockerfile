# 51-04 testbed image (softwareteam-testbed) — see IMPL-PLAN §1. Built HOST-side by
# scripts/build-testbed-image.sh, which resolves + records the base digest, pins node, stages the
# stub assets, and COPYs the local softwareteam pack tarball. Byte-reproducible BY CONTRACT: the base is
# digest-pinned (the verb refuses a tag-floating reference), node is pinned, and softwareteam comes from
# the tree — never the npm registry (0.5.1 is unreleased). Layers are ordered stable -> volatile.

# --- base: a digest-pinned LTS-slim Linux, supplied by the build verb (docker/testbed/base-image,
#     which REFUSES a non-@sha256 reference). No floating tag is baked into this file. ---
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# --- layer 1: userland + tmux + git + PTY/process essentials + the native-build toolchain (most stable) ---
# python3/make/g++ are REQUIRED, not optional: the sealed Q2 packaging ruling builds better-sqlite3
# FRESH ON TARGET (never a prebuilt/nested binary — that would risk a wrong-arch native module). Its
# install is `prebuild-install || node-gyp rebuild`; with a self-contained tarball npm reaches that
# step, prebuild-install is absent, and node-gyp needs python3+make+g++ to compile from source. Without
# them layer 3 dies ('prebuild-install: not found' → 'Could not find any Python installation'). This is
# testbed-image scope only (no multi-stage gold-plating — the image is a throwaway test target).
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git tmux tini procps \
      python3 make g++; \
    rm -rf /var/lib/apt/lists/*

# --- layer 2: pinned node (an in-range engines version — see scripts/check-engines) ---
ARG NODE_VERSION=22.22.1
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      "") echo "TARGETARCH is empty — the legacy (non-BuildKit) builder does not populate it. Pass --build-arg TARGETARCH explicitly (build-testbed-image.sh does) or enable BuildKit. REFUSING to default to amd64, which would install wrong-arch Node." >&2; exit 1 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f /tmp/node.tar.xz; \
    node --version; npm --version

# --- layer 3: the SoftwareTeam package from the LOCAL pack tarball, never the npm registry ---
ARG SOFTWARETEAM_TARBALL
COPY ${SOFTWARETEAM_TARBALL} /tmp/softwareteam.tgz
RUN set -eux; \
    npm install -g /tmp/softwareteam.tgz; \
    rm -f /tmp/softwareteam.tgz; \
    SoftwareTeam --version

# --- layer 4: stub runtime assets (zero-token by construction; staged by the build verb into the
#     build context as ./stub-assets/, hashed into the manifest via deriveStubAssetsHash) ---
COPY stub-assets/ /opt/softwareteam-testbed/stub-assets/

# --- layer 5: a non-root softwareteam user + a tini entrypoint into tmux-server-friendly init ---
RUN set -eux; \
    useradd --create-home --shell /bin/bash softwareteam; \
    mkdir -p /opt/softwareteam-testbed; \
    chown -R softwareteam:softwareteam /opt/softwareteam-testbed
COPY entrypoint.sh /opt/softwareteam-testbed/entrypoint.sh
RUN chmod 0755 /opt/softwareteam-testbed/entrypoint.sh
USER softwareteam
WORKDIR /home/softwareteam
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/softwareteam-testbed/entrypoint.sh"]
CMD ["sleep", "infinity"]
