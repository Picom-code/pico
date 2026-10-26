import sys, os
sys.path.insert(0, os.environ["SANDBOX"])
from pager import paginate, page_count
L = [1, 2, 3, 4, 5]
assert paginate(L, 1, 2) == [1, 2]
assert paginate(L, 2, 2) == [3, 4]
assert paginate(L, 3, 2) == [5]
assert paginate(L, 4, 2) == []
assert paginate([], 1, 3) == []
assert page_count(0, 3) == 0
assert page_count(5, 2) == 3
assert page_count(6, 2) == 3
assert page_count(1, 10) == 1
print("ok")
