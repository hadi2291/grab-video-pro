const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'downloads.json');

class Storage {
  constructor() {
    this.items = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        this.items = JSON.parse(raw);
        // Reset any items that were left as downloading to paused upon startup
        for (const item of this.items) {
          if (item.status === 'downloading') {
            item.status = 'paused';
            item.speed = 0;
            item.eta = null;
          }
        }
      } else {
        this.items = [];
        this.save();
      }
    } catch (err) {
      console.error('Error loading downloads.json:', err);
      this.items = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.items, null, 2), 'utf8');
    } catch (err) {
      console.error('Error saving downloads.json:', err);
    }
  }

  getAll() {
    return this.items;
  }

  getById(id) {
    return this.items.find(item => item.id === id);
  }

  add(item) {
    this.items.unshift(item);
    this.save();
    return item;
  }

  update(id, updates) {
    const item = this.getById(id);
    if (item) {
      Object.assign(item, updates, { updatedAt: new Date().toISOString() });
      this.save();
      return item;
    }
    return null;
  }

  remove(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index !== -1) {
      const removed = this.items.splice(index, 1)[0];
      this.save();
      return removed;
    }
    return null;
  }

  removeMany(ids) {
    const idSet = new Set(ids);
    const removed = [];
    this.items = this.items.filter(item => {
      if (idSet.has(item.id)) {
        removed.push(item);
        return false;
      }
      return true;
    });
    if (removed.length > 0) {
      this.save();
    }
    return removed;
  }
}

module.exports = new Storage();
