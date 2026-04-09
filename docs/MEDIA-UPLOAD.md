# Media Upload Guide

Guide to uploading images and media files using Bunny.net CDN.

## Overview

Vormex uses **Bunny.net** for media storage and CDN delivery. The upload flow is:

1. Frontend uploads file directly to Bunny.net
2. Frontend receives CDN URL
3. Frontend sends CDN URL to backend API
4. Backend stores URL in database

## Why Bunny.net?

- **Fast CDN**: Global edge network
- **Cost-effective**: Pay-as-you-go pricing
- **Easy integration**: Simple REST API
- **Image optimization**: Automatic compression
- **Storage zones**: Organized file structure

## Setup

### 1. Create Bunny.net Account

1. Sign up at https://bunny.net
2. Create a Storage Zone
3. Get Storage Zone name and Access Key

### 2. Configure Environment

Add to `.env`:

```env
BUNNY_STORAGE_ZONE="vormex-media"
BUNNY_ACCESS_KEY="your-access-key-here"
BUNNY_CDN_URL="https://vormex.b-cdn.net"
```

### 3. Storage Zone Structure

```
vormex-media/
├── avatars/
│   └── {userId}.jpg
├── banners/
│   └── {userId}.jpg
├── posts/
│   └── {postId}/
│       ├── image1.jpg
│       └── image2.jpg
├── projects/
│   └── {projectId}/
│       ├── screenshot1.jpg
│       └── screenshot2.jpg
└── certificates/
    └── {certificateId}.pdf
```

## Upload Flow

### Frontend Implementation

```typescript
async function uploadToBunny(file: File, path: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(
    `https://storage.bunny.net/${BUNNY_STORAGE_ZONE}/${path}`,
    {
      method: 'PUT',
      headers: {
        'AccessKey': BUNNY_ACCESS_KEY,
        'Content-Type': file.type,
      },
      body: file,
    }
  );

  if (!response.ok) {
    throw new Error('Upload failed');
  }

  // Return CDN URL
  return `${BUNNY_CDN_URL}/${path}`;
}
```

### Backend Integration

After upload, send CDN URL to backend:

```typescript
// Upload avatar
const avatarUrl = await uploadToBunny(avatarFile, `avatars/${userId}.jpg`);

// Send to backend
await fetch('/api/users/me/avatar', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ avatarUrl }),
});
```

## Endpoints

### Upload Avatar

**POST** `/api/users/me/avatar`

```json
{
  "avatarUrl": "https://vormex.b-cdn.net/avatars/user-id.jpg"
}
```

**Recommended:**
- Format: JPG or PNG
- Dimensions: 400×400px
- Max size: 2MB
- Square aspect ratio

### Upload Banner

**POST** `/api/users/me/banner`

```json
{
  "bannerUrl": "https://vormex.b-cdn.net/banners/user-id.jpg"
}
```

**Recommended:**
- Format: JPG or PNG
- Dimensions: 1500×500px
- Max size: 5MB
- 3:1 aspect ratio

### Project Images

**POST** `/api/users/me/projects`

```json
{
  "name": "My Project",
  "images": [
    "https://vormex.b-cdn.net/projects/project-id/screenshot1.jpg",
    "https://vormex.b-cdn.net/projects/project-id/screenshot2.jpg"
  ]
}
```

**Recommended:**
- Format: JPG or PNG
- Dimensions: 1200×800px (or similar)
- Max size: 3MB per image
- Max 5 images per project

### Certificate Files

**POST** `/api/users/me/certificates`

```json
{
  "name": "AWS Certified",
  "certificateUrl": "https://vormex.b-cdn.net/certificates/cert-id.pdf"
}
```

**Recommended:**
- Format: PDF
- Max size: 10MB

## Image Optimization

### Before Upload

```typescript
// Compress image
async function compressImage(file: File, maxWidth: number, quality: number): Promise<File> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        
        // Calculate new dimensions
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
        
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob(
          (blob) => resolve(new File([blob!], file.name, { type: 'image/jpeg' })),
          'image/jpeg',
          quality
        );
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Usage
const compressed = await compressImage(avatarFile, 400, 0.8);
const url = await uploadToBunny(compressed, `avatars/${userId}.jpg`);
```

## Error Handling

### Upload Failures

```typescript
try {
  const url = await uploadToBunny(file, path);
  // Success
} catch (error) {
  if (error.status === 401) {
    // Invalid access key
  } else if (error.status === 403) {
    // Permission denied
  } else if (error.status === 413) {
    // File too large
  } else {
    // Network error
  }
}
```

### Backend Validation

Backend validates:
- URL format (must be from Bunny.net CDN)
- File extension (jpg, png, pdf)
- File size (checked on frontend, validated on backend)

## Security

### Access Control

- Storage Zone access key should be **server-side only** (never expose in frontend)
- Use signed URLs for temporary access
- Implement rate limiting

### File Validation

```typescript
function validateImage(file: File): boolean {
  const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const maxSize = 5 * 1024 * 1024; // 5MB
  
  if (!validTypes.includes(file.type)) {
    return false;
  }
  
  if (file.size > maxSize) {
    return false;
  }
  
  return true;
}
```

## Best Practices

1. **Optimize Before Upload**
   - Compress images
   - Resize to recommended dimensions
   - Use WebP format when possible

2. **Organize Files**
   - Use consistent naming: `{userId}.jpg`
   - Group by type: `avatars/`, `banners/`, etc.
   - Include timestamps for versioning

3. **Error Handling**
   - Show user-friendly error messages
   - Retry failed uploads
   - Validate file before upload

4. **User Experience**
   - Show upload progress
   - Preview before upload
   - Allow crop/resize in browser

5. **CDN Caching**
   - Set appropriate cache headers
   - Use versioned URLs for updates
   - Invalidate cache on update

## Example: Complete Avatar Upload

```typescript
async function uploadAvatar(file: File, userId: string, token: string) {
  try {
    // 1. Validate
    if (!validateImage(file)) {
      throw new Error('Invalid image file');
    }

    // 2. Compress
    const compressed = await compressImage(file, 400, 0.8);

    // 3. Upload to Bunny.net
    const avatarUrl = await uploadToBunny(
      compressed,
      `avatars/${userId}.jpg`
    );

    // 4. Save URL to backend
    const response = await fetch('/api/users/me/avatar', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ avatarUrl }),
    });

    if (!response.ok) {
      throw new Error('Failed to save avatar URL');
    }

    return avatarUrl;
  } catch (error) {
    console.error('Avatar upload failed:', error);
    throw error;
  }
}
```

## Cost Optimization

### Bunny.net Pricing

- **Storage**: $0.01/GB/month
- **Bandwidth**: $0.01/GB
- **Requests**: Free (unlimited)

### Tips

1. **Compress Images**: Reduce file size = lower bandwidth costs
2. **Use WebP**: Better compression than JPG/PNG
3. **Lazy Load**: Only load images when needed
4. **CDN Caching**: Reduce bandwidth with proper cache headers

## Troubleshooting

### Upload Fails

- Check access key is correct
- Verify storage zone name
- Check file size limits
- Ensure CORS is configured

### Images Not Loading

- Verify CDN URL is correct
- Check file path matches
- Ensure file exists in storage zone
- Check browser console for errors

### Slow Uploads

- Compress images before upload
- Use WebP format
- Implement chunked uploads for large files
- Consider using Bunny.net's upload API

## Next Steps

- [Profile API Guide](PROFILE-API.md)
- [Activity Calendar Guide](ACTIVITY-CALENDAR.md)

