#!/usr/bin/env python3
"""Minimal GNU-format `ar rcs` for ELF objects, used when building
kvm-unit-tests on macOS: the system ar writes BSD archives whose symbol index
ld.lld cannot use for ELF objects.

usage: ar.py rcs ARCHIVE OBJECT...
"""

import struct
import sys


def defined_globals(data):
    """Names of the global and weak symbols an ELF32/ELF64 object defines"""
    if data[:4] != b"\x7fELF":
        return []
    is64 = data[4] == 2
    little = data[5] == 1
    e = "<" if little else ">"
    if is64:
        shoff, = struct.unpack_from(e + "Q", data, 0x28)
        shentsize, shnum = struct.unpack_from(e + "HH", data, 0x3A)
    else:
        shoff, = struct.unpack_from(e + "I", data, 0x20)
        shentsize, shnum = struct.unpack_from(e + "HH", data, 0x2E)

    def section(i):
        base = shoff + i * shentsize
        if is64:
            _name, sh_type, _flags, _addr, offset, size, link, _info, _align, entsize = \
                struct.unpack_from(e + "IIQQQQIIQQ", data, base)
        else:
            _name, sh_type, _flags, _addr, offset, size, link, _info, _align, entsize = \
                struct.unpack_from(e + "IIIIIIIIII", data, base)
        return sh_type, offset, size, link, entsize

    names = []
    for i in range(shnum):
        sh_type, offset, size, link, entsize = section(i)
        if sh_type != 2:  # SHT_SYMTAB
            continue
        _, str_offset, _, _, _ = section(link)
        for sym in range(offset + entsize, offset + size, entsize):  # skip the null symbol
            if is64:
                st_name, st_info, _other, st_shndx = struct.unpack_from(e + "IBBH", data, sym)
            else:
                st_name, = struct.unpack_from(e + "I", data, sym)
                st_info, _other, st_shndx = struct.unpack_from(e + "BBH", data, sym + 12)
            binding = st_info >> 4
            if binding in (1, 2) and st_shndx != 0:  # GLOBAL/WEAK, defined
                end = data.index(b"\0", str_offset + st_name)
                names.append(data[str_offset + st_name:end])
    return names


def header(name, size):
    return b"%-16s%-12d%-6d%-6d%-8o%-10d`\n" % (name, 0, 0, 0, 0o644, size)


def main():
    if len(sys.argv) < 3 or "r" not in sys.argv[1]:
        sys.exit(__doc__)
    archive, paths = sys.argv[2], sys.argv[3:]
    members = [(path.rsplit("/", 1)[-1].encode(), open(path, "rb").read()) for path in paths]

    # long name table for names that do not fit in 16 bytes
    long_names = b""
    member_names = []
    for name, _ in members:
        if len(name) < 16:
            member_names.append(name + b"/")
        else:
            member_names.append(b"/%d" % len(long_names))
            long_names += name + b"/\n"

    symbols = [[sym for sym in defined_globals(data)] for _, data in members]
    symbol_count = sum(len(s) for s in symbols)
    symbol_names = b"".join(sym + b"\0" for s in symbols for sym in s)
    index_size = 4 + 4 * symbol_count + len(symbol_names)

    # offsets of the member headers
    offset = 8 + 60 + index_size + (index_size & 1)
    if long_names:
        offset += 60 + len(long_names) + (len(long_names) & 1)
    member_offsets = []
    for _, data in members:
        member_offsets.append(offset)
        offset += 60 + len(data) + (len(data) & 1)

    out = [b"!<arch>\n", header(b"/", index_size), struct.pack(">I", symbol_count)]
    for member_offset, s in zip(member_offsets, symbols):
        out.append(struct.pack(">I", member_offset) * len(s))
    out.append(symbol_names + b"\n" * (index_size & 1))
    if long_names:
        out.append(header(b"//", len(long_names)) + long_names + b"\n" * (len(long_names) & 1))
    for name, (_, data) in zip(member_names, members):
        out.append(header(name, len(data)) + data + b"\n" * (len(data) & 1))

    with open(archive, "wb") as f:
        f.write(b"".join(out))


if __name__ == "__main__":
    main()
