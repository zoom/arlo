/**
 * In-Memory Store for Demo Mode
 *
 * SECURITY: This store exists only in memory and is cleared on server restart.
 * No customer data is ever persisted to disk or database.
 *
 * This provides session-only storage for:
 * - User sessions (during their active session)
 * - OAuth tokens (encrypted, in-memory only)
 * - PKCE challenges (short-lived)
 *
 * All data is automatically cleared when:
 * - The server restarts
 * - The session expires
 * - The user logs out
 */

const crypto = require('crypto');

// In-memory stores
const users = new Map();          // Map<id, User>
const usersByZoomId = new Map();  // Map<zoomUserId, id>
const tokens = new Map();         // Map<userId, TokenData>

/**
 * Generate a unique ID
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * User operations
 */
const userStore = {
  /**
   * Find user by ID
   */
  findById(id) {
    return users.get(id) || null;
  },

  /**
   * Find user by Zoom user ID
   */
  findByZoomId(zoomUserId) {
    const id = usersByZoomId.get(zoomUserId);
    return id ? users.get(id) : null;
  },

  /**
   * Create or update user (upsert)
   */
  upsert(zoomUserId, data) {
    let user = this.findByZoomId(zoomUserId);

    if (user) {
      // Update existing user
      user = {
        ...user,
        ...data,
        zoomUserId,
        updatedAt: new Date(),
      };
      users.set(user.id, user);
    } else {
      // Create new user
      user = {
        id: generateId(),
        zoomUserId,
        email: data.email,
        displayName: data.displayName,
        avatarUrl: data.avatarUrl || null,
        preferences: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.set(user.id, user);
      usersByZoomId.set(zoomUserId, user.id);
    }

    return user;
  },

  /**
   * Update user preferences
   */
  updatePreferences(userId, preferences) {
    const user = users.get(userId);
    if (!user) return null;

    user.preferences = { ...user.preferences, ...preferences };
    user.updatedAt = new Date();
    users.set(userId, user);
    return user;
  },

  /**
   * Get user preferences
   */
  getPreferences(userId) {
    const user = users.get(userId);
    return user?.preferences || {};
  },

  /**
   * Check if user exists
   */
  exists(zoomUserId) {
    return usersByZoomId.has(zoomUserId);
  },

  /**
   * Delete user and associated tokens
   */
  delete(userId) {
    const user = users.get(userId);
    if (user) {
      usersByZoomId.delete(user.zoomUserId);
      users.delete(userId);
      tokens.delete(userId);
    }
  },
};

/**
 * Token operations
 */
const tokenStore = {
  /**
   * Store encrypted tokens for a user
   */
  store(userId, tokenData) {
    tokens.set(userId, {
      ...tokenData,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  },

  /**
   * Get tokens for a user
   */
  get(userId) {
    return tokens.get(userId) || null;
  },

  /**
   * Update tokens for a user
   */
  update(userId, tokenData) {
    const existing = tokens.get(userId);
    if (existing) {
      tokens.set(userId, {
        ...existing,
        ...tokenData,
        updatedAt: new Date(),
      });
    }
  },

  /**
   * Delete tokens for a user
   */
  delete(userId) {
    tokens.delete(userId);
  },

  /**
   * Check if tokens exist and are not expired
   */
  isValid(userId) {
    const tokenData = tokens.get(userId);
    if (!tokenData) return false;
    return new Date(tokenData.expiresAt) > new Date();
  },
};

/**
 * Clear all stored data (for testing or manual reset)
 */
function clearAll() {
  users.clear();
  usersByZoomId.clear();
  tokens.clear();
  console.log('Memory store cleared');
}

/**
 * Get store statistics (for debugging)
 */
function getStats() {
  return {
    users: users.size,
    tokens: tokens.size,
  };
}

module.exports = {
  userStore,
  tokenStore,
  clearAll,
  getStats,
  generateId,
};
