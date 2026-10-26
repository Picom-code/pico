def build_report(income, expenses, taxes):
    lines = []
    lines.append("REPORT")
    label = "Income"
    amount = income
    pad = 30 - len(label) - len("%.2f" % amount)
    lines.append(label + "." * max(pad, 1) + "%.2f" % amount)
    label = "Expenses"
    amount = expenses
    pad = 30 - len(label) - len("%.2f" % amount)
    lines.append(label + "." * max(pad, 1) + "%.2f" % amount)
    label = "Taxes"
    amount = taxes
    pad = 30 - len(label) - len("%.2f" % amount)
    lines.append(label + "." * max(pad, 1) + "%.2f" % amount)
    net = income - expenses - taxes
    lines.append("-" * 30)
    label = "Net"
    amount = net
    pad = 30 - len(label) - len("%.2f" % amount)
    lines.append(label + "." * max(pad, 1) + "%.2f" % amount)
    return "\n".join(lines)
