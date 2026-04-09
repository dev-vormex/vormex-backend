# Username Field Implementation - Frontend Integration Guide

## Overview

The Vormex backend now includes a **username** field for all users. This enables:
- Clean profile URLs: `/users/@koushik` instead of `/users/uuid-here`
- Username-based login
- @mentions support (future feature)
- Better user identification

**Username is permanent** - cannot be changed after registration.

---

## Breaking Changes

### 1. Registration Endpoint
- **NEW REQUIRED FIELD**: `username` must be provided during registration
- Username validation rules apply (see below)

### 2. Login Endpoint
- **FLEXIBLE**: Now accepts `email` OR `username` (or `emailOrUsername` field)
- Backward compatible: email login still works

### 3. Profile Endpoints
- **FLEXIBLE**: Accept UUID OR username in URL path
- Supports `@username` format (e.g., `/users/@koushik/profile`)

---

## Username Validation Rules

### Format Requirements
- **Length**: 3-30 characters
- **Pattern**: Lowercase letters, numbers, and underscores only
- **Must start with**: A letter (a-z)
- **Case**: Automatically converted to lowercase

### Valid Examples
```
✅ koushik
✅ koushik_dev
✅ john123
✅ user_name_123
✅ a1b2c3
```

### Invalid Examples
```
❌ ko (too short, < 3 chars)
❌ _koushik (starts with underscore)
❌ Koushik (uppercase not allowed)
❌ koushik- (hyphen not allowed)
❌ ko@ushik (special characters not allowed)
❌ admin (reserved username)
```

### Reserved Usernames
The following usernames are blocked:
- `admin`, `api`, `www`, `app`, `support`, `help`, `about`
- `settings`, `profile`, `login`, `register`, `logout`
- `auth`, `oauth`, `github`, `google`, `apple`
- `me`, `root`, `system`, `test`, `null`, `undefined`

---

## Updated Endpoints

### 1. Register User

**Endpoint**: `POST /api/auth/register`

**Changes**:
- Added required `username` field
- Username validation with specific error messages

**Request Body**:
```json
{
  "email": "student@example.com",
  "password": "SecurePass123!",
  "name": "John Doe",
  "username": "johndoe",  // ⭐ NEW REQUIRED FIELD
  "college": "VIT Vellore",
  "branch": "Computer Science"
}
```

**Success Response** (201):
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "student@example.com",
    "username": "johndoe",  // ⭐ NEW FIELD
    "name": "John Doe",
    "profileImage": null,
    "bio": null,
    "college": "VIT Vellore",
    "branch": "Computer Science",
    "isVerified": false,
    "authProvider": "email",
    "createdAt": "2024-12-05T07:00:00.000Z",
    "updatedAt": "2024-12-05T07:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Responses**:

**400 - Invalid Username Format**:
```json
{
  "error": "Username must be 3-30 characters"
}
// OR
{
  "error": "Username must start with letter and contain only lowercase letters, numbers, underscore"
}
// OR
{
  "error": "Username 'admin' is reserved"
}
```

**409 - Username Already Taken**:
```json
{
  "error": "Username already taken"
}
```

**409 - Email Already Exists**:
```json
{
  "error": "User with this email already exists"
}
```

---

### 2. Login User

**Endpoint**: `POST /api/auth/login`

**Changes**:
- Now accepts `email` OR `username` (or `emailOrUsername`)
- Backward compatible with email-only login

**Request Body Options**:

**Option 1: Email Login** (backward compatible):
```json
{
  "email": "student@example.com",
  "password": "SecurePass123!"
}
```

**Option 2: Username Login** (new):
```json
{
  "username": "johndoe",
  "password": "SecurePass123!"
}
```

**Option 3: Single Field** (new):
```json
{
  "emailOrUsername": "johndoe",  // Can be email or username
  "password": "SecurePass123!"
}
```

**Success Response** (200):
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "student@example.com",
    "username": "johndoe",  // ⭐ NEW FIELD
    "name": "John Doe",
    "profileImage": null,
    "bio": null,
    "college": "VIT Vellore",
    "branch": "Computer Science",
    "isVerified": true,
    "authProvider": "email",
    "createdAt": "2024-12-05T07:00:00.000Z",
    "updatedAt": "2024-12-05T07:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Responses**:

**400 - Missing Credentials**:
```json
{
  "error": "Email or username is required"
}
```

**401 - Invalid Credentials**:
```json
{
  "error": "Invalid email or password"
}
```

---

### 3. Get Current User

**Endpoint**: `GET /api/auth/me`

**Changes**:
- Response now includes `username` field

**Success Response** (200):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "student@example.com",
  "username": "johndoe",  // ⭐ NEW FIELD
  "name": "John Doe",
  "profileImage": null,
  "bio": null,
  "college": "VIT Vellore",
  "branch": "Computer Science",
  "isVerified": true,
  "authProvider": "email",
  "createdAt": "2024-12-05T07:00:00.000Z",
  "updatedAt": "2024-12-05T07:00:00.000Z"
}
```

---

### 4. Get User Profile

**Endpoint**: `GET /api/users/{userId}/profile`

**Changes**:
- `{userId}` parameter now accepts **UUID OR username**
- Supports `@username` format (automatically strips `@` prefix)
- Backward compatible: UUID still works

**URL Examples**:
```
GET /api/users/johndoe/profile          ✅ Username
GET /api/users/@johndoe/profile         ✅ Username with @ prefix
GET /api/users/550e8400-e29b-41d4-a716-446655440000/profile  ✅ UUID (backward compatible)
```

**Success Response** (200):
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "johndoe",  // ⭐ NEW FIELD
    "name": "John Doe",
    "email": "student@example.com",  // Only if viewing own profile
    "avatar": null,
    "bannerImageUrl": null,
    "headline": null,
    "bio": null,
    "location": null,
    "college": "VIT Vellore",
    "degree": null,
    "branch": "Computer Science",
    "currentYear": null,
    "graduationYear": null,
    "portfolioUrl": null,
    "linkedinUrl": null,
    "githubProfileUrl": null,
    "isOpenToOpportunities": false,
    "profileVisibility": "PUBLIC",
    "verified": true,
    "interests": [],
    "createdAt": "2024-12-05T07:00:00.000Z"
  },
  "stats": { ... },
  "github": { ... },
  "activityHeatmap": [ ... ],
  "skills": [ ... ],
  "experiences": [ ... ],
  "education": [ ... ],
  "projects": [ ... ],
  "certificates": [ ... ],
  "achievements": [ ... ]
}
```

**Error Responses**:

**404 - User Not Found**:
```json
{
  "error": "User not found"
}
```

---

### 5. Get User Feed

**Endpoint**: `GET /api/users/{userId}/feed`

**Changes**:
- `{userId}` parameter now accepts **UUID OR username**
- Supports `@username` format

**URL Examples**:
```
GET /api/users/johndoe/feed
GET /api/users/@johndoe/feed
GET /api/users/550e8400-e29b-41d4-a716-446655440000/feed
```

**Query Parameters** (unchanged):
- `page` (default: 1)
- `limit` (default: 20, max: 100)
- `filter` (all, posts, articles, forum, videos)

---

### 6. Get User Activity Heatmap

**Endpoint**: `GET /api/users/{userId}/activity`

**Changes**:
- `{userId}` parameter now accepts **UUID OR username**
- Supports `@username` format

**URL Examples**:
```
GET /api/users/johndoe/activity
GET /api/users/@johndoe/activity?year=2024
GET /api/users/550e8400-e29b-41d4-a716-446655440000/activity
```

---

### 7. Get User Activity Years

**Endpoint**: `GET /api/users/{userId}/activity/years`

**Changes**:
- `{userId}` parameter now accepts **UUID OR username**
- Supports `@username` format

---

### 8. Update Profile

**Endpoint**: `PUT /api/users/me`

**Changes**:
- **Username cannot be updated** (permanent field)
- If `username` is provided in request body, returns 400 error

**Request Body**:
```json
{
  "headline": "CSE 2nd year | Android & ML enthusiast",
  "bio": "Passionate developer...",
  "location": "Hyderabad, India",
  "currentYear": 2,
  "degree": "B.Tech",
  "graduationYear": 2026,
  "portfolioUrl": "https://johndoe.dev",
  "linkedinUrl": "https://linkedin.com/in/johndoe",
  "profileVisibility": "PUBLIC"
  // ⚠️ username field is IGNORED if provided
}
```

**Error Response** (400 - Username Update Attempted):
```json
{
  "error": "Username cannot be changed after registration"
}
```

---

### 9. Google OAuth Sign-In

**Endpoint**: `POST /api/auth/google`

**Changes**:
- Username is **auto-generated** from user's name
- Response includes `username` field

**Request Body** (unchanged):
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ij..."
}
```

**Success Response** (200/201):
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@gmail.com",
    "username": "john_doe_1234",  // ⭐ Auto-generated
    "name": "John Doe",
    "profileImage": "https://lh3.googleusercontent.com/...",
    "isVerified": true,
    "authProvider": "google",
    "createdAt": "2024-12-05T07:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Note**: OAuth users get auto-generated usernames like `john_doe_1234` (from name + random suffix).

---

## Frontend Implementation Guide

### 1. Registration Form

**Required Changes**:
- Add username input field
- Validate username on client-side before submission
- Show username availability check (optional, but recommended)

**Example Implementation**:
```typescript
interface RegisterForm {
  email: string;
  password: string;
  name: string;
  username: string;  // ⭐ NEW REQUIRED FIELD
  college?: string;
  branch?: string;
}

// Username validation function
function validateUsername(username: string): { valid: boolean; error?: string } {
  const trimmed = username.trim().toLowerCase();
  
  if (trimmed.length < 3 || trimmed.length > 30) {
    return { valid: false, error: 'Username must be 3-30 characters' };
  }
  
  if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
    return { valid: false, error: 'Username must start with letter and contain only lowercase letters, numbers, underscore' };
  }
  
  const reserved = ['admin', 'api', 'www', 'app', 'support', 'help', 'about', 'settings', 'profile', 'login', 'register', 'logout'];
  if (reserved.includes(trimmed)) {
    return { valid: false, error: `Username '${trimmed}' is reserved` };
  }
  
  return { valid: true };
}

// Registration API call
async function register(data: RegisterForm) {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: data.email,
      password: data.password,
      name: data.name,
      username: data.username.toLowerCase().trim(),  // Normalize
      college: data.college,
      branch: data.branch,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }
  
  return response.json();
}
```

---

### 2. Login Form

**Required Changes**:
- Support email OR username input
- Single input field that accepts both

**Example Implementation**:
```typescript
interface LoginForm {
  emailOrUsername: string;  // Can be email or username
  password: string;
}

// Login API call
async function login(data: LoginForm) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      emailOrUsername: data.emailOrUsername,
      password: data.password,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }
  
  return response.json();
}

// Alternative: Use separate email/username fields
interface LoginFormAlternative {
  email?: string;
  username?: string;
  password: string;
}

async function loginAlternative(data: LoginFormAlternative) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: data.email,
      username: data.username,
      password: data.password,
    }),
  });
  
  return response.json();
}
```

---

### 3. Profile URLs

**Required Changes**:
- Update profile route to accept username or UUID
- Support `@username` format
- Update all profile links to use username when available

**Example Implementation**:
```typescript
// Profile URL helper
function getProfileUrl(user: { id: string; username: string }): string {
  // Prefer username if available
  return `/users/${user.username}`;
}

// Profile route handler (React Router example)
<Route path="/users/:userId/profile" element={<ProfilePage />} />

// Profile page component
function ProfilePage() {
  const { userId } = useParams();
  
  // Remove @ prefix if present
  const identifier = userId?.startsWith('@') ? userId.substring(1) : userId;
  
  // Fetch profile (works with UUID or username)
  const { data, error } = useQuery(['profile', identifier], () =>
    fetch(`/api/users/${identifier}/profile`).then(res => res.json())
  );
  
  // ...
}
```

---

### 4. User Display

**Required Changes**:
- Display username alongside or instead of name
- Use username for profile links
- Show username in user cards, comments, etc.

**Example Implementation**:
```typescript
interface User {
  id: string;
  email: string;
  username: string;  // ⭐ NEW FIELD
  name: string;
  profileImage?: string;
  // ... other fields
}

// User card component
function UserCard({ user }: { user: User }) {
  return (
    <Link to={`/users/${user.username}`}>
      <div>
        <img src={user.profileImage || '/default-avatar.png'} alt={user.name} />
        <h3>{user.name}</h3>
        <p>@{user.username}</p>  {/* ⭐ Display username */}
      </div>
    </Link>
  );
}
```

---

### 5. Profile Update

**Required Changes**:
- Remove username field from profile edit form
- Show username as read-only if displayed
- Handle error if user tries to update username

**Example Implementation**:
```typescript
// Profile edit form (username is read-only)
function ProfileEditForm({ user }: { user: User }) {
  return (
    <form>
      {/* Username display (read-only) */}
      <div>
        <label>Username</label>
        <input type="text" value={user.username} disabled />
        <small>Username cannot be changed</small>
      </div>
      
      {/* Other editable fields */}
      <input name="headline" defaultValue={user.headline} />
      <textarea name="bio" defaultValue={user.bio} />
      {/* ... */}
    </form>
  );
}
```

---

## Migration Checklist

### Immediate Actions Required

- [ ] **Registration Form**: Add username input field with validation
- [ ] **Login Form**: Support email OR username input
- [ ] **User Type/Interface**: Add `username: string` field
- [ ] **Profile URLs**: Update to use username instead of UUID
- [ ] **Profile Links**: Update all user links to use username
- [ ] **User Display**: Show username in user cards/components
- [ ] **Profile Edit**: Remove username from editable fields

### Optional Enhancements

- [ ] **Username Availability Check**: Add real-time username availability API call
- [ ] **Username Suggestions**: Suggest available usernames if taken
- [ ] **@mention Support**: Prepare UI for @mentions (future feature)
- [ ] **Username Search**: Add username-based user search

---

## Error Handling

### Username Validation Errors

Handle these specific error messages:

```typescript
const usernameErrors = {
  'Username must be 3-30 characters': 'TOO_SHORT_OR_LONG',
  'Username must start with letter and contain only lowercase letters, numbers, underscore': 'INVALID_FORMAT',
  'Username \'admin\' is reserved': 'RESERVED',
  'Username already taken': 'TAKEN',
};
```

### Example Error Handling

```typescript
try {
  await register(formData);
} catch (error) {
  if (error.message === 'Username already taken') {
    setUsernameError('This username is already taken. Please choose another.');
  } else if (error.message.includes('Username must')) {
    setUsernameError(error.message);
  } else {
    setError(error.message);
  }
}
```

---

## Testing Checklist

### Registration
- [ ] Register with valid username → Success
- [ ] Register with taken username → 409 error
- [ ] Register with invalid username format → 400 error
- [ ] Register with reserved username → 400 error
- [ ] Register with uppercase username → Auto-converted to lowercase

### Login
- [ ] Login with email → Success
- [ ] Login with username → Success
- [ ] Login with @username format → Success (if supported)
- [ ] Login with invalid credentials → 401 error

### Profile
- [ ] Get profile by UUID → Success
- [ ] Get profile by username → Success
- [ ] Get profile by @username → Success
- [ ] Get profile with invalid username → 404 error

### Profile Update
- [ ] Update profile without username field → Success
- [ ] Update profile with username field → 400 error (username cannot be changed)

---

## API Response Examples

### User Object (All Endpoints)

All user objects now include `username`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "student@example.com",
  "username": "johndoe",
  "name": "John Doe",
  "profileImage": null,
  "bio": null,
  "college": "VIT Vellore",
  "branch": "Computer Science",
  "isVerified": true,
  "authProvider": "email",
  "createdAt": "2024-12-05T07:00:00.000Z",
  "updatedAt": "2024-12-05T07:00:00.000Z"
}
```

---

## Support

For questions or issues:
- Check OpenAPI documentation: `/api-docs` (Swagger UI)
- Review API responses for error details
- Username validation follows strict rules - ensure client-side validation matches

---

## Version Information

- **Backend Version**: Updated with username support
- **Migration Date**: December 5, 2024
- **Breaking Changes**: Registration requires username
- **Backward Compatibility**: Login and profile endpoints support both UUID and username

---

**Last Updated**: December 5, 2024


