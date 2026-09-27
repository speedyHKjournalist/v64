#!/bin/sh
# Build seabios.bin/vgabios.bin (and the -debug variants) from a pinned SeaBIOS
# release. Fails instead of building from an unexpected or modified checkout.
set -eu

SEABIOS_REPO=https://git.seabios.org/seabios.git
SEABIOS_TAG=rel-1.16.2

if [ ! -d seabios/.git ]
then
    git clone "$SEABIOS_REPO" seabios
fi
git -C seabios fetch --tags origin
git -C seabios checkout --detach "$SEABIOS_TAG"
test "$(git -C seabios describe --tags --exact-match)" = "$SEABIOS_TAG"
if ! git -C seabios diff --quiet HEAD
then
    echo "seabios/ has local modifications; refusing to build" >&2
    exit 1
fi

cp seabios.config seabios/.config
make -C seabios clean
make -C seabios
cp seabios/out/bios.bin seabios.bin
cp seabios/out/vgabios.bin vgabios.bin

cp seabios-debug.config seabios/.config
make -C seabios clean
make -C seabios
cp seabios/out/bios.bin seabios-debug.bin
cp seabios/out/vgabios.bin vgabios-debug.bin

echo "SeaBIOS $SEABIOS_TAG ($(git -C seabios rev-parse HEAD)):"
shasum -a 256 seabios.bin vgabios.bin seabios-debug.bin vgabios-debug.bin
