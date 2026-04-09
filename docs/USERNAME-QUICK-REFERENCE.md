# Username Implementation - Quick Reference

## 🚨 Breaking Changes

1. **Registration**: `username` field is now **REQUIRED**
2. **Login**: Accepts `email` OR `username` (backward compatible)
3. **Profile URLs**: Accept UUID OR username (backward compatible)

---

## 📋 Username Rules

- **Length**: 3-30 characters
- **Format**: Lowercase letters, numbers, underscore only
- **Must start with**: Letter (a-z)
- **Reserved**: admin, api, www, app, support, help, about, settings, profile, login, register, logout, auth, oauth, github, google, apple, me, root, system, test, null, undefined
- **Permanent**: Cannot be changed after registration

---

## 🔄 Updated Endpoints

### 1. POST /api/auth/register
**NEW**: `username` required in request body

```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "name": "John Doe",
  "username": "johndoe"  // ⭐ REQUIRED
}
```

**Errors**:
- `400`: Invalid username format
- `409`: Username already taken

---

### 2. POST /api/auth/login
**NEW**: Accepts `email` OR `username` OR `emailOrUsername`

```json
// Option 1: Email
{ "email": "user@example.com", "password": "..." }

// Option 2: Username
{ "username": "johndoe", "password": "..." }

// Option 3: Single field
{ "emailOrUsername": "johndoe", "password": "..." }
```

---

### 3. GET /api/users/{userId}/profile
**NEW**: `{userId}` accepts UUID OR username

```
GET /api/users/johndoe/profile          ✅ Username
GET /api/users/@johndoe/profile         ✅ Username with @
GET /api/users/{uuid}/profile           ✅ UUID (backward compatible)
```

---

### 4. GET /api/users/{userId}/feed
**NEW**: `{userId}` accepts UUID OR username

---

### 5. GET /api/users/{userId}/activity
**NEW**: `{userId}` accepts UUID OR username

---

### 6. GET /api/users/{userId}/activity/years
**NEW**: `{userId}` accepts UUID OR username

---

### 7. PUT /api/users/me
**NEW**: Username cannot be updated (returns 400 if attempted)

---

### 8. POST /api/auth/google
**NEW**: Username auto-generated, included in response

---

## 📦 Response Changes

All user objects now include `username`:

```json
{
  "id": "...",
  "email": "...",
  "username": "johndoe",  // ⭐ NEW FIELD
  "name": "...",
  ...
}
```

---

## 💻 Frontend Checklist

- [ ] Add `username` field to registration form
- [ ] Add username validation (client-side)
- [ ] Update login to accept email OR username
- [ ] Update user type/interface to include `username`
- [ ] Update profile URLs to use username
- [ ] Remove username from profile edit form
- [ ] Display username in user cards/components

---

## 🔍 Validation Examples

**Valid**: `koushik`, `john_doe`, `user123`, `a1b2c3`

**Invalid**: `ko` (too short), `_koushik` (starts with _), `Koushik` (uppercase), `admin` (reserved)

---

## 📚 Full Documentation

See `docs/USERNAME-IMPLEMENTATION.md` for complete details, code examples, and migration guide.


