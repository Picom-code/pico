import ast, os, sys
sys.path.insert(0, os.environ["SANDBOX"])
src = open(os.path.join(os.environ["SANDBOX"], "report.py")).read()
import report
assert hasattr(report, "format_row"), "no format_row"
assert report.format_row("Income", 1000) == "Income.................1000.00"
assert report.format_row("A", 1, width=10) == "A.....1.00"
assert report.format_row("Very long label here", 123456789.0, width=10).endswith("123456789.00")
exp = "REPORT\nIncome.................1000.00\nExpenses................250.50\nTaxes...................100.00\n" + "-" * 30 + "\nNet.....................649.50"
assert report.build_report(1000, 250.5, 100) == exp
tree = ast.parse(src)
fn = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "build_report"][0]
assert src.count('"%.2f" % amount') + src.count("'%.2f' % amount") <= 2, "duplication still present"
calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "format_row"]
assert calls, "build_report does not call format_row"
print("ok")
