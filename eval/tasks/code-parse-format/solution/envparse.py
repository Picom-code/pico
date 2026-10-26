import re

def parse_env(text):
    out = {}
    def expand(v):
        return re.sub(r"\$\{(\w+)\}", lambda m: out.get(m.group(1), ""), v)
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if "=" not in s:
            raise ValueError(f"line {i}: missing '='")
        k, v = s.split("=", 1)
        k = k.strip()
        if k.startswith("export "):
            k = k[7:].strip()
        v = v.strip()
        if v.startswith('"'):
            body = v[1:v.rindex('"')] if v.count('"') > 1 else v[1:]
            body = re.sub(r'\\(.)', lambda m: "\n" if m.group(1) == "n" else m.group(1), body)
            v = expand(body)
        elif v.startswith("'"):
            v = v[1:v.rindex("'")] if v.count("'") > 1 else v[1:]
        else:
            v = expand(re.sub(r"\s+#.*$", "", v).strip())
        out[k] = v
    return out
