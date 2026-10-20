const cors = require("cors");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const {
  createHash,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require("crypto");
const { promisify } = require("util");

const app = express();
const port = 5001;
const db = new sqlite3.Database(path.join(__dirname, "social_media.db"));
const scrypt = promisify(scryptCallback);
const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        reject(error);
      } else {
        resolve(this);
      }
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
      } else {
        resolve(row);
      }
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
      } else {
        resolve(rows);
      }
    });
  });
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function asyncMiddleware(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getContent(req) {
  const content =
    req.body && typeof req.body.content === "string"
      ? req.body.content.trim()
      : "";
  if (!content) {
    throw new HttpError(400, "Content is required");
  }
  if (content.length > 2000) {
    throw new HttpError(400, "Content must be 2000 characters or fewer");
  }
  return content;
}

function getId(value, label = "ID") {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return id;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();
  await run(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [hashToken(token), userId, expiresAt]
  );
  return { token, expiresAt };
}

async function attachUser(req, optional = false) {
  const authorization = req.get("authorization") || "";
  if (!authorization) {
    if (optional) return;
    throw new HttpError(401, "Sign in to continue");
  }
  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) {
    throw new HttpError(401, "Invalid or expired session");
  }

  const session = await get(
    `SELECT u.id, u.username, u.display_name, u.bio, u.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [hashToken(match[1]), new Date().toISOString()]
  );
  if (!session) {
    throw new HttpError(401, "Invalid or expired session");
  }
  req.user = session;
  req.tokenHash = hashToken(match[1]);
}

const requireAuth = asyncMiddleware(async (req, res, next) => {
  await attachUser(req);
  next();
});

const optionalAuth = asyncMiddleware(async (req, res, next) => {
  await attachUser(req, true);
  next();
});

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    bio: user.bio || "",
    created_at: user.created_at,
    followers: Number(user.followers || 0),
    following: Number(user.following || 0),
    is_following: Boolean(user.is_following),
  };
}

async function getPosts(viewerId = null, username = null) {
  const conditions = [];
  const params = [];
  if (username !== null) {
    conditions.push("u.username = ?");
    params.push(username);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const posts = await all(
    `SELECT p.id, p.user_id, p.content, p.created_at,
       COALESCE(u.username, 'community') AS author_username,
       COALESCE(u.display_name, 'Community member') AS author_name,
       (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
       CASE WHEN ? IS NULL THEN 0 ELSE
         EXISTS (SELECT 1 FROM likes mine WHERE mine.post_id = p.id AND mine.user_id = ?)
       END AS liked_by_me
     FROM posts p
     LEFT JOIN users u ON u.id = p.user_id
     ${where}
     ORDER BY p.created_at DESC, p.id DESC`,
    [viewerId, viewerId, ...params]
  );
  const comments = await all(
    `SELECT c.id, c.post_id, c.user_id, c.content, c.created_at,
       COALESCE(u.username, 'community') AS author_username,
       COALESCE(u.display_name, 'Community member') AS author_name
     FROM comments c
     LEFT JOIN users u ON u.id = c.user_id
     ORDER BY c.id ASC`
  );
  const commentsByPost = new Map(posts.map((post) => [post.id, []]));
  for (const comment of comments) {
    const postComments = commentsByPost.get(comment.post_id);
    if (postComments) {
      postComments.push({
        id: comment.id,
        post_id: comment.post_id,
        user_id: comment.user_id,
        content: comment.content,
        created_at: comment.created_at,
        author: {
          username: comment.author_username,
          display_name: comment.author_name,
        },
      });
    }
  }

  return posts.map((post) => ({
    id: post.id,
    content: post.content,
    created_at: post.created_at,
    likes: Number(post.likes),
    liked_by_me: Boolean(post.liked_by_me),
    author: {
      id: post.user_id,
      username: post.author_username,
      display_name: post.author_name,
    },
    comments: commentsByPost.get(post.id),
  }));
}

async function addColumnIfMissing(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initializeDatabase() {
  await run("PRAGMA foreign_keys = ON");
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, following_id),
      CHECK (follower_id != following_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await addColumnIfMissing(
    "posts",
    "user_id",
    "INTEGER REFERENCES users(id) ON DELETE SET NULL"
  );
  await addColumnIfMissing(
    "comments",
    "user_id",
    "INTEGER REFERENCES users(id) ON DELETE SET NULL"
  );
  await addColumnIfMissing(
    "likes",
    "user_id",
    "INTEGER REFERENCES users(id) ON DELETE CASCADE"
  );
  await run(
    "CREATE UNIQUE INDEX IF NOT EXISTS likes_post_user ON likes(post_id, user_id) WHERE user_id IS NOT NULL"
  );
  await run(
    "CREATE INDEX IF NOT EXISTS posts_user_created ON posts(user_id, created_at DESC)"
  );
  await run(
    "CREATE INDEX IF NOT EXISTS comments_post_id ON comments(post_id, id)"
  );
  await run(
    "CREATE INDEX IF NOT EXISTS follows_following_id ON follows(following_id)"
  );
  await run("DELETE FROM sessions WHERE expires_at <= ?", [
    new Date().toISOString(),
  ]);

  const postCount = await get("SELECT COUNT(*) AS count FROM posts");
  if (postCount.count > 0) return;

  await run("BEGIN TRANSACTION");
  try {
    const samplePosts = [
      {
        content: "Welcome to the community! What are you building today?",
        comments: ["Excited to be here!", "Looking forward to connecting."],
      },
      {
        content: "Share one thing you learned this week.",
        comments: ["I learned more about working with SQLite."],
      },
    ];
    for (const post of samplePosts) {
      const result = await run("INSERT INTO posts (content) VALUES (?)", [
        post.content,
      ]);
      for (const comment of post.comments) {
        await run(
          "INSERT INTO comments (post_id, content) VALUES (?, ?)",
          [result.lastID, comment]
        );
      }
    }
    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK");
    throw error;
  }
}

app.post(
  "/api/auth/register",
  asyncRoute(async (req, res) => {
    const username =
      typeof req.body?.username === "string"
        ? req.body.username.trim().toLowerCase()
        : "";
    const displayName =
      typeof req.body?.display_name === "string"
        ? req.body.display_name.trim()
        : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      throw new HttpError(
        400,
        "Username must be 3-24 characters using letters, numbers, or underscores"
      );
    }
    if (displayName.length < 2 || displayName.length > 40) {
      throw new HttpError(400, "Display name must be 2-40 characters");
    }
    if (password.length < 8 || password.length > 128) {
      throw new HttpError(400, "Password must be 8-128 characters");
    }

    const existing = await get("SELECT id FROM users WHERE username = ?", [
      username,
    ]);
    if (existing) {
      throw new HttpError(409, "That username is already taken");
    }
    const salt = randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    const storedPassword = `${salt.toString("hex")}:${passwordHash.toString("hex")}`;
    let result;
    try {
      result = await run(
        `INSERT INTO users (username, display_name, password_hash)
         VALUES (?, ?, ?)`,
        [username, displayName, storedPassword]
      );
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT") {
        throw new HttpError(409, "That username is already taken");
      }
      throw error;
    }
    const user = await get(
      "SELECT id, username, display_name, bio, created_at FROM users WHERE id = ?",
      [result.lastID]
    );
    const session = await createSession(user.id);
    res.status(201).json({ user, ...session });
  })
);

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const username =
      typeof req.body?.username === "string"
        ? req.body.username.trim().toLowerCase()
        : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";
    const user = await get("SELECT * FROM users WHERE username = ?", [username]);
    if (!user) {
      throw new HttpError(401, "Incorrect username or password");
    }
    const [saltHex, hashHex] = user.password_hash.split(":");
    const salt = Buffer.from(saltHex, "hex");
    const savedHash = Buffer.from(hashHex, "hex");
    const providedHash = await scrypt(password, salt, savedHash.length);
    if (
      savedHash.length !== providedHash.length ||
      !timingSafeEqual(savedHash, providedHash)
    ) {
      throw new HttpError(401, "Incorrect username or password");
    }
    const session = await createSession(user.id);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio,
        created_at: user.created_at,
      },
      ...session,
    });
  })
);

app.get(
  "/api/auth/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(req.user);
  })
);

app.post(
  "/api/auth/logout",
  requireAuth,
  asyncRoute(async (req, res) => {
    await run("DELETE FROM sessions WHERE token_hash = ?", [req.tokenHash]);
    res.json({ message: "Signed out" });
  })
);

app.get(
  "/api/posts",
  optionalAuth,
  asyncRoute(async (req, res) => {
    res.json(await getPosts(req.user?.id ?? null));
  })
);

app.post(
  "/api/posts",
  requireAuth,
  asyncRoute(async (req, res) => {
    const content = getContent(req);
    const result = await run(
      "INSERT INTO posts (user_id, content) VALUES (?, ?)",
      [req.user.id, content]
    );
    const posts = await getPosts(req.user.id);
    res.status(201).json(posts.find((post) => post.id === result.lastID));
  })
);

app.post(
  "/api/posts/:id/like",
  requireAuth,
  asyncRoute(async (req, res) => {
    const postId = getId(req.params.id, "Post ID");
    const post = await get("SELECT id FROM posts WHERE id = ?", [postId]);
    if (!post) throw new HttpError(404, "Post not found");

    await run(
      "INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)",
      [postId, req.user.id]
    );
    const result = await get(
      "SELECT COUNT(*) AS likes FROM likes WHERE post_id = ?",
      [postId]
    );
    res.json({ postId, likes: Number(result.likes), liked: true });
  })
);

app.delete(
  "/api/posts/:id/like",
  requireAuth,
  asyncRoute(async (req, res) => {
    const postId = getId(req.params.id, "Post ID");
    const post = await get("SELECT id FROM posts WHERE id = ?", [postId]);
    if (!post) throw new HttpError(404, "Post not found");

    await run("DELETE FROM likes WHERE post_id = ? AND user_id = ?", [
      postId,
      req.user.id,
    ]);
    const result = await get(
      "SELECT COUNT(*) AS likes FROM likes WHERE post_id = ?",
      [postId]
    );
    res.json({ postId, likes: Number(result.likes), liked: false });
  })
);

app.post(
  "/api/posts/:id/comments",
  requireAuth,
  asyncRoute(async (req, res) => {
    const postId = getId(req.params.id, "Post ID");
    const content = getContent(req);
    const post = await get("SELECT id FROM posts WHERE id = ?", [postId]);
    if (!post) throw new HttpError(404, "Post not found");

    const result = await run(
      "INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)",
      [postId, req.user.id, content]
    );
    const comment = await get(
      `SELECT c.id, c.post_id, c.user_id, c.content, c.created_at,
         u.username AS author_username, u.display_name AS author_name
       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [result.lastID]
    );
    res.status(201).json({
      id: comment.id,
      post_id: comment.post_id,
      user_id: comment.user_id,
      content: comment.content,
      created_at: comment.created_at,
      author: {
        username: comment.author_username,
        display_name: comment.author_name,
      },
    });
  })
);

app.get(
  "/api/users",
  requireAuth,
  asyncRoute(async (req, res) => {
    const users = await all(
      `SELECT u.id, u.username, u.display_name, u.bio, u.created_at,
         (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followers,
         (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following,
         EXISTS (
           SELECT 1 FROM follows mine
           WHERE mine.follower_id = ? AND mine.following_id = u.id
         ) AS is_following
       FROM users u
       WHERE u.id != ?
       ORDER BY followers DESC, u.created_at ASC`,
      [req.user.id, req.user.id]
    );
    res.json(users.map(publicUser));
  })
);

app.get(
  "/api/users/:username",
  optionalAuth,
  asyncRoute(async (req, res) => {
    const username = req.params.username.toLowerCase();
    const user = await get(
      `SELECT u.id, u.username, u.display_name, u.bio, u.created_at,
         (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followers,
         (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following,
         CASE WHEN ? IS NULL THEN 0 ELSE EXISTS (
           SELECT 1 FROM follows mine
           WHERE mine.follower_id = ? AND mine.following_id = u.id
         ) END AS is_following
       FROM users u WHERE u.username = ?`,
      [req.user?.id ?? null, req.user?.id ?? null, username]
    );
    if (!user) throw new HttpError(404, "User not found");
    const profile = publicUser(user);
    profile.is_self = req.user?.id === user.id;
    profile.posts = await getPosts(req.user?.id ?? null, user.username);
    res.json(profile);
  })
);

app.post(
  "/api/users/:id/follow",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = getId(req.params.id, "User ID");
    if (userId === req.user.id) {
      throw new HttpError(400, "You cannot follow yourself");
    }
    const user = await get("SELECT id FROM users WHERE id = ?", [userId]);
    if (!user) throw new HttpError(404, "User not found");
    await run(
      "INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)",
      [req.user.id, userId]
    );
    const result = await get(
      "SELECT COUNT(*) AS followers FROM follows WHERE following_id = ?",
      [userId]
    );
    res.json({ userId, following: true, followers: Number(result.followers) });
  })
);

app.delete(
  "/api/users/:id/follow",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = getId(req.params.id, "User ID");
    await run(
      "DELETE FROM follows WHERE follower_id = ? AND following_id = ?",
      [req.user.id, userId]
    );
    const result = await get(
      "SELECT COUNT(*) AS followers FROM follows WHERE following_id = ?",
      [userId]
    );
    res.json({ userId, following: false, followers: Number(result.followers) });
  })
);

app.put(
  "/api/users/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const displayName =
      typeof req.body?.display_name === "string"
        ? req.body.display_name.trim()
        : "";
    const bio = typeof req.body?.bio === "string" ? req.body.bio.trim() : "";
    if (displayName.length < 2 || displayName.length > 40) {
      throw new HttpError(400, "Display name must be 2-40 characters");
    }
    if (bio.length > 160) {
      throw new HttpError(400, "Bio must be 160 characters or fewer");
    }
    await run("UPDATE users SET display_name = ?, bio = ? WHERE id = ?", [
      displayName,
      bio,
      req.user.id,
    ]);
    const user = await get(
      "SELECT id, username, display_name, bio, created_at FROM users WHERE id = ?",
      [req.user.id]
    );
    res.json(user);
  })
);

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status =
    Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : error.type === "entity.parse.failed"
        ? 400
        : 500;
  if (status === 500) {
    console.error("Request failed:", error);
  }
  res.status(status).json({
    error:
      status === 500
        ? "Internal server error"
        : error.message || "Invalid request body",
  });
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize the database:", error);
    db.close(() => {
      process.exitCode = 1;
    });
  });
