def format_row(label, amount, width=30):
    num = "%.2f" % amount
    return label + "." * max(width - len(label) - len(num), 1) + num


def build_report(income, expenses, taxes):
    lines = ["REPORT"]
    for label, amount in (("Income", income), ("Expenses", expenses), ("Taxes", taxes)):
        lines.append(format_row(label, amount))
    lines.append("-" * 30)
    lines.append(format_row("Net", income - expenses - taxes))
    return "\n".join(lines)
