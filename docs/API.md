# Vormex Backend API Documentation

## 📋 Overview

Welcome to the Vormex Backend API documentation. This API provides authentication and user management endpoints for the Vormex social networking platform.

**API Version:** 0.1.0  
**Content-Type:** `application/json`  
**Base URL (Development):** `http://localhost:5000`  
**Base URL (Production):** `https://api.vormex.in` (TBD)

---

## 🔐 Authentication

The API uses **JSON Web Tokens (JWT)** for authentication. After successful login or registration, you'll receive a JWT token that must be included in subsequent authenticated requests.

### How to Use JWT Tokens

1. **Get Token:** After successful login/register, extract the `token` from the response
2. **Include in Requests:** Add the token to the `Authorization` header:
   ```
   Authorization: Bearer <your-jwt-token>
   ```
3. **Token Expiration:** Tokens expire after **7 days**. Users need to login again after expiration.

### Example Request with Authentication

```bash
curl -X GET https://api.vormex.in/api/user/profile \
  -H "X-Example-Auth: supply-at-runtime"
```

### Authentication Flow

**Email/Password Users:**
1. **Register** → Account created with `isVerified: false`
2. **Verification Email Sent** → Automatically sent to user's email from `noreply@vormex.in`
3. **User Clicks Link** → Opens verification link in email (token expires in 24 hours)
4. **Email Verified** → `isVerified: true` in database
5. **User Can Login** → Now able to authenticate and receive JWT token

**Google OAuth Users:**
1. **Sign In with Google** → Account created/updated with `isVerified: true` automatically
2. **Immediate Access** → Can use the app right away (no verification needed)

**Resending Verification:**
- If verification email not received or token expired, use `POST /api/auth/resend-verification`
- New verification token will be generated and sent (24-hour expiry)

---

## ❌ Error Handling

All error responses follow a consistent format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### HTTP Status Codes

| Status Code | Description |
|-------------|-------------|
| `200` | Success (OK) |
| `201` | Success (Created) |
| `400` | Bad Request - Validation error or invalid input |
| `401` | Unauthorized - Invalid or missing authentication token |
| `403` | Forbidden - Insufficient permissions or email not verified |
| `409` | Conflict - Resource already exists (e.g., duplicate email) |
| `500` | Internal Server Error - Server-side error |

---

## 📍 Endpoints

### Health Check

#### GET /api/health

Check if the API server and database are running.

**Authentication:** ❌ Not required

**Request:**
```bash
curl -X GET http://localhost:3000/api/health
```

**Success Response (200):**
```json
{
  "status": "ok",
  "timestamp": 1704067200000,
  "database": "connected"
}
```

**Error Response (503):**
```json
{
  "status": "error",
  "timestamp": 1704067200000,
  "database": "disconnected",
  "message": "Database connection failed"
}
```

---

### Authentication Endpoints

#### POST /api/auth/register

Register a new user with email and password.

**Authentication:** ❌ Not required

**📧 Email Verification:** After successful registration, a verification email is automatically sent to the user's email address from `noreply@vormex.in`. The user receives a `user` object and `token` in the response, but **cannot login until they verify their email**. The verification token expires in **24 hours**.

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**
```typescript
{
  email: string;        // Required, valid email format
  password: string;     // Required, minimum 8 characters
  name: string;         // Required
  college?: string;     // Optional
  branch?: string;      // Optional
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "John Doe",
    "college": "MIT",
    "branch": "Computer Science"
  }'
```

**Success Response (201):**
```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe",
    "college": "MIT",
    "branch": "Computer Science",
    "profileImage": null,
    "bio": null,
    "graduationYear": null,
    "isVerified": false,
    "authProvider": "email",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "token": "REMOVED_SECRET"
}
```

**Error Responses:**

**400 - Missing Required Fields:**
```json
{
  "error": "Email, password, and name are required"
}
```

**400 - Invalid Email Format:**
```json
{
  "error": "Invalid email format"
}
```

**400 - Password Too Short:**
```json
{
  "error": "Password must be at least 8 characters long"
}
```

**409 - Email Already Exists:**
```json
{
  "error": "User with this email already exists"
}
```

**500 - Server Error:**
```json
{
  "error": "Internal server error during registration"
}
```

---

#### POST /api/auth/login

Login with email and password.

**Authentication:** ❌ Not required

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**
```typescript
{
  email: string;      // Required
  password: string;   // Required
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

**Success Response (200):**
```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe",
    "college": "MIT",
    "branch": "Computer Science",
    "profileImage": null,
    "bio": null,
    "graduationYear": null,
    "isVerified": false,
    "authProvider": "email",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "token": "REMOVED_SECRET"
}
```

**Error Responses:**

**400 - Missing Fields:**
```json
{
  "error": "Email and password are required"
}
```

**401 - Invalid Credentials:**
```json
{
  "error": "Invalid email or password"
}
```

**401 - OAuth User:**
```json
{
  "error": "This account uses OAuth authentication. Please sign in with your OAuth provider."
}
```

**403 - Email Not Verified:**
```json
{
  "error": "Please verify your email before logging in. Check your inbox for verification link.",
  "requiresVerification": true
}
```

**Note:** Unverified users cannot login. The `requiresVerification: true` flag indicates that the user needs to verify their email. Google OAuth users are automatically verified and can login immediately.

**500 - Server Error:**
```json
{
  "error": "Internal server error during login"
}
```

---

#### POST /api/auth/forgot-password

Request a password reset email. The API will send a reset link to the provided email if it exists in the system.

**Authentication:** ❌ Not required

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**
```typescript
{
  email: string;  // Required, valid email format
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

**Success Response (200):**
```json
{
  "message": "If email exists, password reset link has been sent"
}
```

**Note:** The API always returns 200 for security reasons (prevents email enumeration attacks), even if the email doesn't exist.

**Error Responses:**

**400 - Missing Email:**
```json
{
  "error": "Email is required"
}
```

**400 - Invalid Email Format:**
```json
{
  "error": "Invalid email format"
}
```

---

#### POST /api/auth/reset-password

Reset password using the token received via email.

**Authentication:** ❌ Not required

**Request Headers:**
```
Content-Type: application/json
```

**Query Parameters:**
```
token: string  // Required, reset token from email
```

**Request Body:**
```typescript
{
  newPassword: string;  // Required, minimum 8 characters
}
```

**Example Request:**
```bash
curl -X POST "http://localhost:3000/api/auth/reset-password?token=REMOVED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "newPassword": "newpassword123"
  }'
```

**Success Response (200):**
```json
{
  "message": "Password reset successful. You can now login with your new password."
}
```

**Error Responses:**

**400 - Missing Fields:**
```json
{
  "error": "Token and new password are required"
}
```

**400 - Password Too Short:**
```json
{
  "error": "Password must be at least 8 characters long"
}
```

**400 - Invalid/Expired Token:**
```json
{
  "error": "Invalid or expired reset token"
}
```

**500 - Server Error:**
```json
{
  "error": "Internal server error during password reset"
}
```

**Note:** Reset tokens expire after 1 hour. Request a new token if expired.

---

## 📧 Email Verification

Email verification is **required** for email/password users before they can login. This ensures users own the email address they registered with and helps prevent spam accounts.

### Why Email Verification?

- ✅ **Security:** Confirms user owns the email address
- ✅ **Account Recovery:** Enables password reset functionality
- ✅ **Spam Prevention:** Reduces fake account creation
- ✅ **Communication:** Ensures important emails reach users

### Verification Flow

1. **Registration:** User registers → Verification email sent automatically
2. **Email Received:** User receives email from `noreply@vormex.in` with verification link
3. **Click Link:** User clicks link → Email verified, `isVerified: true`
4. **Can Login:** User can now login with email/password

### Token Expiration

- Verification tokens expire after **24 hours**
- If expired, use `POST /api/auth/resend-verification` to get a new token
- Each resend generates a new token (previous tokens become invalid)

### OAuth Users

Google OAuth users are **automatically verified** (`isVerified: true`) since Google already verifies email addresses. They skip the email verification step entirely.

### Email Verification Endpoints

#### GET /api/auth/verify-email

Verify user's email address with token from verification email.

**Authentication:** ❌ Not required

**Query Parameters:**
```
token: string  // Required, verification token from email
```

**Example Request:**
```bash
curl -X GET "http://localhost:3000/api/auth/verify-email?token=REMOVED_SECRET"
```

**Success Response (200):**
```json
{
  "message": "Email verified successfully! You can now access all features."
}
```

**Error Responses:**

**400 - Missing Token:**
```json
{
  "error": "Verification token is required"
}
```

**400 - Invalid/Expired Token:**
```json
{
  "error": "Invalid or expired verification token"
}
```

**400 - Already Verified:**
```json
{
  "error": "Email is already verified"
}
```

**500 - Server Error:**
```json
{
  "error": "Internal server error during email verification"
}
```

**Note:** Verification tokens expire after **24 hours**. If expired, use the resend verification endpoint to get a new token.

---

#### POST /api/auth/resend-verification

Resend verification email to user. Useful if the original email wasn't received or the token expired.

**Authentication:** ❌ Not required

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**
```typescript
{
  email: string;  // Required, valid email format
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/resend-verification \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

**Success Response (200):**
```json
{
  "message": "Verification email sent. Please check your inbox."
}
```

**Note:** The API always returns 200 for security reasons (prevents email enumeration attacks), even if the email doesn't exist or is already verified.

**Error Responses:**

**400 - Missing Email:**
```json
{
  "error": "Email is required"
}
```

**400 - Invalid Email Format:**
```json
{
  "error": "Invalid email format"
}
```

**400 - Already Verified:**
```json
{
  "error": "Email is already verified"
}
```

**400 - OAuth User:**
```json
{
  "error": "OAuth users do not need email verification"
}
```

**500 - Server Error:**
```json
{
  "error": "Internal server error during resend verification"
}
```

---

#### POST /api/auth/google

Authenticate or register using Google Sign-In. The frontend should obtain a Google ID token from Google's authentication service and send it to this endpoint.

**Authentication:** ❌ Not required

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**
```typescript
{
  idToken: string;  // Required, Google ID token from frontend
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{
    "idToken": "REMOVED_SECRET"
  }'
```

**Success Response (200/201):**

**Existing User (200):**
```json
{
  "user": {
    "id": 1,
    "email": "user@gmail.com",
    "name": "John Doe",
    "college": null,
    "branch": null,
    "profileImage": "https://lh3.googleusercontent.com/...",
    "bio": null,
    "graduationYear": null,
    "isVerified": true,
    "authProvider": "google",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "token": "REMOVED_SECRET"
}
```

**New User (201):**
```json
{
  "user": {
    "id": 2,
    "email": "newuser@gmail.com",
    "name": "Jane Smith",
    "college": null,
    "branch": null,
    "profileImage": "https://lh3.googleusercontent.com/...",
    "bio": null,
    "graduationYear": null,
    "isVerified": true,
    "authProvider": "google",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "token": "REMOVED_SECRET"
}
```

**Error Responses:**

**400 - Missing Token:**
```json
{
  "error": "idToken is required"
}
```

**400 - Invalid Token Format:**
```json
{
  "error": "idToken must be a non-empty string"
}
```

**401 - Invalid Google Token:**
```json
{
  "error": "Failed to verify Google token. Please try again."
}
```

**409 - Email Already Registered:**
```json
{
  "error": "This email is already registered with email/password. Please login with your password or reset it."
}
```

**500 - Server Error:**
```json
{
  "error": "Internal server error during Google sign-in"
}
```

**Frontend Integration Notes:**
1. Use Google Sign-In SDK (web) or Google Sign-In library (mobile) to get the ID token
2. Send the ID token to this endpoint immediately after receiving it
3. Store the returned JWT token for authenticated requests
4. The backend verifies the token with Google's servers before processing

---

## 🧪 Test Credentials

For development and testing purposes, you can use the following test account:

```
Email: exptech01738@gmail.com
Password: test@123
```

**Note:** This account is for development only. Do not use in production.

---

## 🔧 Environment Variables

### Frontend Environment Setup

Create a `.env` file in your frontend project with the following variables:

```env
# API Configuration
VITE_API_BASE_URL=http://localhost:3000
# or for production:
# VITE_API_BASE_URL=https://api.vormex.in

# Google OAuth (for web)
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

### Backend Environment Variables

The backend requires these environment variables (not needed by frontend):

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://...

# JWT
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com

# Email (Resend)
RESEND_API_KEY=your-resend-api-key
EMAIL_FROM=noreply@vormex.in
FRONTEND_URL=http://localhost:3000
```

---

## 🌐 CORS Configuration

The API currently allows all origins in development mode. In production, CORS will be restricted to specific frontend domains.

**Development:** All origins allowed (`*`)  
**Production:** Restricted to `https://vormex.in` and `https://www.vormex.in`

---

## ⚡ Rate Limiting

Rate limiting is **not yet implemented** but will be added in future versions to prevent abuse. Planned limits:

- Authentication endpoints: 5 requests per minute per IP
- Password reset: 3 requests per hour per email
- General API: 100 requests per minute per IP

---

## 📝 Changelog

### Version 0.1.0 (Current)

**Implemented Features:**
- ✅ User registration with email/password
- ✅ User login with email/password
- ✅ Email verification system (verify/resend)
- ✅ Password reset via email (forgot/reset)
- ✅ Google OAuth authentication
- ✅ JWT token-based authentication
- ✅ Health check endpoint
- ✅ Comprehensive error handling
- ✅ Input validation
- ✅ Security best practices

**Coming Soon:**
- 🔜 User profile management endpoints
- 🔜 Apple Sign-In OAuth
- 🔜 Refresh token mechanism
- 🔜 Rate limiting
- 🔜 WebSocket support for real-time messaging
- 🔜 Post/Feed endpoints
- 🔜 Social features (follow, like, comment)

---

## 📞 Support

For API support or questions:
- **Email:** support@vormex.in
- **Documentation:** This file
- **Issues:** GitHub Issues (if applicable)

---

## 🔒 Security Notes

1. **Always use HTTPS in production** - Never send tokens over unencrypted connections
2. **Store tokens securely** - Use secure storage (not localStorage for sensitive apps)
3. **Token expiration** - Tokens expire after 7 days; implement token refresh logic
4. **Password requirements** - Minimum 8 characters (enforced by backend)
5. **Email verification** - **Required** for email/password users before login. Google OAuth users are auto-verified.
6. **OAuth tokens** - Google ID tokens are verified server-side; never trust client-side tokens
7. **Verification tokens** - Expire after 24 hours; users can request new verification email if needed

---

## 📚 Additional Resources

- [JWT.io](https://jwt.io/) - JWT token decoder and debugger
- [Google Sign-In Documentation](https://developers.google.com/identity/sign-in/web/sign-in)
- [REST API Best Practices](https://restfulapi.net/)

---

**Last Updated:** January 2024  
**API Version:** 0.1.0
