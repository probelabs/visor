// Style issue: inconsistent naming
function calculate_total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

module.exports = { calculate_total };