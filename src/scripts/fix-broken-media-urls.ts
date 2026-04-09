/**
 * Migration script to fix posts with broken media URLs
 * 
 * This script:
 * 1. Finds all posts with mediaUrls containing "/uploads/" paths (broken local paths)
 * 2. Clears those broken URLs and changes type to TEXT if no valid media remains
 * 
 * Run with: npx ts-node src/scripts/fix-broken-media-urls.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixBrokenMediaUrls() {
  console.log('🔍 Finding posts with broken media URLs...');
  
  // Find all posts that have mediaUrls
  const postsWithMedia = await prisma.post.findMany({
    where: {
      mediaUrls: {
        isEmpty: false,
      },
    },
    select: {
      id: true,
      mediaUrls: true,
      type: true,
      content: true,
    },
  });
  
  console.log(`Found ${postsWithMedia.length} posts with media URLs`);
  
  let fixedCount = 0;
  let skippedCount = 0;
  
  for (const post of postsWithMedia) {
    // Check if any mediaUrl contains "/uploads/" (local path)
    const hasBrokenUrls = post.mediaUrls.some(url => 
      url.includes('/uploads/') || !url.startsWith('http')
    );
    
    if (hasBrokenUrls) {
      // Filter out broken URLs, keep only valid CDN URLs
      const validUrls = post.mediaUrls.filter(url => 
        url.startsWith('https://') && !url.includes('/uploads/')
      );
      
      // Determine new type based on remaining media
      let newType = post.type;
      if (validUrls.length === 0) {
        // No valid media left, convert to TEXT if there's content
        newType = 'text';
      }
      
      // Update the post
      await prisma.post.update({
        where: { id: post.id },
        data: {
          mediaUrls: validUrls,
          type: newType,
        },
      });
      
      console.log(`✅ Fixed post ${post.id}: removed ${post.mediaUrls.length - validUrls.length} broken URLs, type changed to ${newType}`);
      fixedCount++;
    } else {
      skippedCount++;
    }
  }
  
  console.log('\n📊 Summary:');
  console.log(`   Fixed: ${fixedCount} posts`);
  console.log(`   Skipped (already valid): ${skippedCount} posts`);
  console.log('\n✨ Done!');
}

fixBrokenMediaUrls()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
