import ast, os, sys, doctest
p = os.path.join(os.environ["SANDBOX"], "geometry.py")
tree = ast.parse(open(p).read())
fns = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
assert {f.name for f in fns} >= {"distance", "centroid", "perimeter", "scale"}
for f in fns:
    for a in f.args.args:
        assert a.annotation is not None, f"{f.name}.{a.arg} unannotated"
    assert f.returns is not None, f"{f.name} has no return type"
src = ast.unparse([f for f in fns if f.name == "centroid"][0].returns)
assert "None" in src or "Optional" in src, "centroid must allow None: " + src
sys.path.insert(0, os.environ["SANDBOX"])
import geometry as g
assert g.distance((0, 0), (3, 4)) == 5.0
assert g.centroid([]) is None and g.centroid([(0, 0), (2, 4)]) == (1.0, 2.0)
assert g.perimeter([(0, 0), (3, 0), (3, 4)]) == 12.0
assert g.perimeter([(0, 0), (3, 0), (3, 4)], closed=False) == 7.0
assert g.scale([(1, 2)], 2) == [(2, 4)]
r = doctest.testmod(g); assert r.failed == 0
import subprocess
cp = subprocess.run([sys.executable, "-c", "import geometry"], cwd=os.environ["SANDBOX"])
assert cp.returncode == 0
print("ok")
