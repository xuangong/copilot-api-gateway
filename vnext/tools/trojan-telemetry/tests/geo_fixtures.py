"""Writers for tiny geo databases used as test fixtures (nothing large is committed)."""
import ipaddress
import struct

XDB_HEADER = 256
XDB_VECTOR = 256 * 256 * 8
XDB_BLOCK = 14


def build_xdb(segments, ip_version=0):
    """ip2region xdb (IPv4): segments is [(start ip, end ip, region)], sorted and not overlapping. Segments are split at /16 boundaries
    like the official maker does, so every vector cell points at the blocks that start inside it."""
    blocks = []
    for start, end, region in segments:
        first, last = int(ipaddress.IPv4Address(start)), int(ipaddress.IPv4Address(end))
        while first <= last:
            cell_end = (first | 0xFFFF)
            blocks.append((first, min(last, cell_end), region))
            first = min(last, cell_end) + 1
    data = bytearray()
    region_at = {}
    base = XDB_HEADER + XDB_VECTOR
    for _, _, region in blocks:
        if region not in region_at:
            region_at[region] = base + len(data)
            data += region.encode("utf-8")
    index_start = base + len(data)
    index = bytearray()
    vector = {}
    for number, (first, last, region) in enumerate(blocks):
        pointer = index_start + number * XDB_BLOCK
        encoded = region.encode("utf-8")
        index += struct.pack("<IIHI", first, last, len(encoded), region_at[region])
        cell = ((first >> 24) & 0xFF) * 256 + ((first >> 16) & 0xFF)
        low, _ = vector.get(cell, (pointer, pointer))
        vector[cell] = (low, pointer)
    vector_bytes = bytearray(XDB_VECTOR)
    for cell, (low, high) in vector.items():
        struct.pack_into("<II", vector_bytes, cell * 8, low, high)
    last_pointer = index_start + max(0, len(blocks) - 1) * XDB_BLOCK
    header = bytearray(XDB_HEADER)
    struct.pack_into("<HHIII", header, 0, 2, 1, 1700000000, index_start, last_pointer)
    struct.pack_into("<H", header, 16, ip_version)
    return bytes(header) + bytes(vector_bytes) + bytes(data) + bytes(index)


# ---- MaxMind DB ----

def _control(kind, size):
    if size < 29:
        length, extra = size, b""
    elif size < 285:
        length, extra = 29, bytes(bytearray([size - 29]))
    elif size < 65821:
        length, extra = 30, struct.pack(">H", size - 285)
    else:
        length, extra = 31, struct.pack(">I", size - 65821)[1:]
    if kind <= 7:
        return bytes(bytearray([(kind << 5) | length])) + extra
    return bytes(bytearray([length, kind - 7])) + extra


def _uint(value):
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    kind = 5 if value < 2 ** 16 else 6 if value < 2 ** 32 else 9
    return _control(kind, len(raw)) + raw


def pointer(offset):
    """A data-section pointer to `offset` (relative to the data section start), in the smallest encoding."""
    if offset < 2048:
        return bytes(bytearray([0x20 | (offset >> 8), offset & 0xFF]))
    if offset < 2048 + 524288:
        offset -= 2048
        return bytes(bytearray([0x28 | (offset >> 16), (offset >> 8) & 0xFF, offset & 0xFF]))
    if offset < 2048 + 524288 + 134217728:
        offset -= 2048 + 524288
        return bytes(bytearray([0x30 | (offset >> 24), (offset >> 16) & 0xFF, (offset >> 8) & 0xFF, offset & 0xFF]))
    return b"\x38" + struct.pack(">I", offset)


class DataSection(object):
    """Encodes values (str, bool, int, float, list, dict) into a MaxMind data section; with `pointers` a repeated string becomes a
    pointer to its first occurrence, as real databases do."""

    def __init__(self, pointers=True):
        self.data = bytearray()
        self.pointers = pointers
        self.seen = {}

    def add(self, value):
        """Appends a top-level value and returns its offset."""
        offset = len(self.data)
        self._put(value)
        return offset

    def _put(self, value):
        data = self.data
        if isinstance(value, bool):
            data += _control(14, 1 if value else 0)
        elif isinstance(value, str):
            raw = value.encode("utf-8")
            if self.pointers and value in self.seen:
                data += pointer(self.seen[value])
                return
            self.seen[value] = len(data)
            data += _control(2, len(raw)) + raw
        elif isinstance(value, float):
            data += _control(3, 8) + struct.pack(">d", value)
        elif isinstance(value, int):
            data += _uint(value)
        elif isinstance(value, list):
            data += _control(11, len(value))
            for item in value:
                self._put(item)
        elif isinstance(value, dict):
            data += _control(7, len(value))
            for key, item in value.items():
                self._put(key)
                self._put(item)
        else:
            raise TypeError(type(value))


def build_mmdb(networks, record_size=24, ip_version=6, pointers=True):
    """A MaxMind DB from [(cidr, record)]. In an ip_version 6 tree IPv4 networks live under ::/96 (the layout DB-IP uses)."""
    section = DataSection(pointers)
    leaves = []
    for cidr, record in networks:
        network = ipaddress.ip_network(cidr)
        if network.version == 6 and ip_version == 4:
            raise ValueError("IPv6 network in an IPv4 tree")
        offset = section.add(record)
        value, bits, width = int(network.network_address), network.prefixlen, 32 if network.version == 4 else 128
        if network.version == 4 and ip_version == 6:
            width, bits = 128, bits + 96
        leaves.append((value, bits, width, offset))
    nodes = [[None, None]]
    for value, bits, width, offset in leaves:
        node = 0
        for depth in range(bits):
            bit = (value >> (width - 1 - depth)) & 1
            if depth == bits - 1:
                nodes[node][bit] = ("data", offset)
            else:
                following = nodes[node][bit]
                if following is None or following[0] != "node":
                    nodes.append([None, None])
                    following = ("node", len(nodes) - 1)
                    nodes[node][bit] = following
                node = following[1]
    count = len(nodes)

    def number(entry):
        if entry is None:
            return count
        return entry[1] if entry[0] == "node" else count + 16 + entry[1]

    tree = bytearray()
    for left, right in nodes:
        a, b = number(left), number(right)
        if record_size == 24:
            tree += a.to_bytes(3, "big") + b.to_bytes(3, "big")
        elif record_size == 28:
            tree += (a & 0xFFFFFF).to_bytes(3, "big") + bytes(bytearray([((a >> 24) << 4) | (b >> 24)])) + (b & 0xFFFFFF).to_bytes(3, "big")
        else:
            tree += a.to_bytes(4, "big") + b.to_bytes(4, "big")
    metadata = DataSection(pointers=False)
    metadata.add({"binary_format_major_version": 2, "binary_format_minor_version": 0, "build_epoch": 1700000000, "database_type": "Test",
                  "description": {"en": "fixture"}, "ip_version": ip_version, "languages": ["en"], "node_count": count,
                  "record_size": record_size})
    return bytes(tree) + b"\x00" * 16 + bytes(section.data) + b"\xab\xcd\xefMaxMind.com" + bytes(metadata.data)
