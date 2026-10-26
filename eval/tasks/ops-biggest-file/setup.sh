python3 - <<'EOF'
import os, random
r = random.Random(42)
dirs = ["data/logs", "data/cache/a", "data/cache/b", "data/.hidden/old", "data/media"]
for d in dirs: os.makedirs(d, exist_ok=True)
for i in range(40):
    d = r.choice(dirs)
    open(f"{d}/f{i:02d}.dat", "wb").write(b"x" * r.randint(100, 40000))
open("data/media/movie.mp4", "wb").write(b"m" * 50000)
open("data/.hidden/old/core.dump", "wb").write(b"c" * 61234)
open("data/logs/app.log", "wb").write(b"l" * 60000)
EOF
