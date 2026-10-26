class Inventory:
    def __init__(self):
        self._stock = {}

    def add(self, name, qty):
        if not isinstance(qty, int) or qty <= 0:
            raise ValueError("qty must be a positive int")
        self._stock[name] = self._stock.get(name, 0) + qty

    def remove(self, name, qty):
        if not isinstance(qty, int) or qty <= 0:
            raise ValueError("qty must be a positive int")
        have = self._stock.get(name, 0)
        if qty > have:
            raise ValueError("not enough stock")
        if have == qty:
            del self._stock[name]
        else:
            self._stock[name] = have - qty

    def count(self, name):
        return self._stock.get(name, 0)

    def items(self):
        return sorted(self._stock)
