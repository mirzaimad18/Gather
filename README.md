# Gather

A small social media app built with vanilla HTML, CSS, and JavaScript, an Express.js API, and SQLite. Users can create accounts, publish posts, comment, like and unlike posts, edit their profiles, and follow other users.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:5001](http://localhost:5001). Express serves the frontend and API from the same origin.

The first startup creates `social_media.db` beside `server.js` and seeds two example posts with comments if there are no posts. The database is local and intentionally excluded from Git. Back it up separately if you need to preserve local data.

## Features

- Username and password registration, login, and logout
- Password hashing with Node.js `scrypt`
- Persistent bearer-token sessions, expiring after 30 days
- Editable display name and profile bio
- Posts and comments attributed to their authors
- Like and unlike posts, with one like per user per post
- User profiles with post, follower, and following counts
- Follow and unfollow users
- Responsive, single-file frontend in `index.html`
- SQLite database migrations for the original posts, comments, and likes schema

## API

JSON endpoints are prefixed by `/api`. Authenticated routes accept:

```http
Authorization: Bearer <session-token>
```

| Method | Endpoint | Authentication | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | No | Create an account (`username`, `display_name`, `password`) |
| `POST` | `/api/auth/login` | No | Sign in (`username`, `password`) |
| `GET` | `/api/auth/me` | Yes | Get the current account |
| `POST` | `/api/auth/logout` | Yes | Revoke the current session |
| `GET` | `/api/posts` | Optional | Get posts, author information, comments, like counts, and the viewer's like state |
| `POST` | `/api/posts` | Yes | Create a post (`content`) |
| `POST` | `/api/posts/:id/like` | Yes | Like a post |
| `DELETE` | `/api/posts/:id/like` | Yes | Unlike a post |
| `POST` | `/api/posts/:id/comments` | Yes | Add a comment (`content`) |
| `GET` | `/api/users` | Yes | List other users and whether the current user follows them |
| `GET` | `/api/users/:username` | Optional | Get a profile and its posts |
| `POST` | `/api/users/:id/follow` | Yes | Follow a user |
| `DELETE` | `/api/users/:id/follow` | Yes | Unfollow a user |
| `PUT` | `/api/users/me` | Yes | Update the display name and bio |

Registration requires a 3–24 character username containing letters, numbers, or underscores; a 2–40 character display name; and a password of 8–128 characters. Post and comment content is limited to 2,000 characters.

## Project files

- `index.html` — frontend markup, inline styles, and browser JavaScript
- `server.js` — Express server, API routes, and SQLite initialization
- `package.json` / `package-lock.json` — dependencies and npm scripts

## Notes

This is a learning/demo project, not a production authentication service. Before public deployment, add HTTPS, rate limiting, account recovery, email verification, stronger session lifecycle controls, and operational database backups. Keep `social_media.db` and any environment secrets out of public repositories.
