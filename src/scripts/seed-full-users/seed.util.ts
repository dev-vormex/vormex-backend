import * as bcrypt from "bcryptjs";
import { DEFAULT_PASSWORD, SALT, pickRange, generateEmail, prisma, allSkillsFlat, pickN, SKILL_POOLS, pick, PROFICIENCIES, COLLEGES, DEGREES, BRANCHES, JOB_TITLES, COMPANIES, randomDate, PROJECT_NAMES, PROJECT_DESCRIPTIONS, ACHIEVEMENT_TITLES, ACHIEVEMENT_TYPES, ACHIEVEMENT_ORGS, CERT_NAMES, CERT_ORGS, POST_CONTENTS } from "./prisma.util";
import { buildUser } from "./build-user.util";

// ──────────────────────────────────────────────
// MAIN SEED
// ──────────────────────────────────────────────

async function seed() {
    console.log('🌱 Seeding 100 users with 100% complete profiles...\n');
    const hash = await bcrypt.hash(DEFAULT_PASSWORD, SALT);

    // ─── 1. CREATE USERS ──────────────────────────
    const users: ReturnType<typeof buildUser>[] = [];
    for (let i = 0; i < 100; i++) {
        users.push(buildUser(i, hash));
    }

    // Ensure unique usernames and emails
    const seenUsernames = new Set<string>();
    const seenEmails = new Set<string>();
    for (const u of users) {
        while (seenUsernames.has(u.username)) {
            u.username = u.username + pickRange(100, 999);
            u.email = generateEmail(u.username);
        }
        while (seenEmails.has(u.email)) {
            u.email = generateEmail(u.username + pickRange(10, 99));
        }
        seenUsernames.add(u.username);
        seenEmails.add(u.email);
    }

    console.log('  Creating 100 users...');
    const createdUsers: { id: string; interests: string[]; index: number }[] = [];
    for (let i = 0; i < users.length; i++) {
        const u = users[i];
        try {
            const created = await prisma.user.create({ data: u });
            createdUsers.push({ id: created.id, interests: u.interests, index: i });
            // Create UserStats
            await prisma.userStats.create({ data: { userId: created.id } });
        } catch (err: any) {
            if (err.code === 'P2002') {
                console.log(`    ⚠️  Skipped duplicate: ${u.username}`);
                continue;
            }
            throw err;
        }
    }
    console.log(`  ✅ Created ${createdUsers.length} users\n`);

    // ─── 2. ADD SKILLS ──────────────────────────
    console.log('  Adding skills to all users...');
    const allSkills = allSkillsFlat();
    const skillRecords: Record<string, string> = {};
    for (const skillName of allSkills) {
        const existing = await prisma.skill.findUnique({ where: { name: skillName } });
        if (existing) {
            skillRecords[skillName] = existing.id;
        } else {
            const created = await prisma.skill.create({ data: { name: skillName, category: 'Technical' } });
            skillRecords[skillName] = created.id;
        }
    }

    let skillCount = 0;
    for (const user of createdUsers) {
        // 6–10 universal skills from ALL pools (frontend, backend, data, devops, design, etc.)
        const targetCount = pickRange(6, 10);
        const poolKeys = pickN(Object.keys(SKILL_POOLS), pickRange(4, 7));
        let skillNames = [...new Set(poolKeys.flatMap(k => pickN(SKILL_POOLS[k], pickRange(2, 4))))];
        if (skillNames.length < targetCount) {
            skillNames = [...new Set([...skillNames, ...pickN(allSkills, targetCount - skillNames.length)])];
        }
        skillNames = skillNames.slice(0, targetCount);
        for (const skillName of skillNames) {
            const skillId = skillRecords[skillName];
            if (!skillId) continue;
            try {
                await prisma.userSkill.create({
                    data: {
                        userId: user.id,
                        skillId,
                        proficiency: pick(PROFICIENCIES),
                        yearsOfExp: pickRange(0, 4),
                    },
                });
                skillCount++;
            } catch { /* skip dupes */ }
        }
    }
    console.log(`  ✅ ${skillCount} skills assigned\n`);

    // ─── 3. ADD EDUCATION (2–3 records per user) ──────────────────────
    console.log('  Adding 2–3 education records per user...');
    let eduCount = 0;
    for (const user of createdUsers) {
        const u = users[user.index];
        const numEdu = pickRange(2, 3);
        const collegesForUser = pickN(COLLEGES, numEdu);
        for (let e = 0; e < numEdu; e++) {
            try {
                await prisma.education.create({
                    data: {
                        userId: user.id,
                        school: collegesForUser[e] || u.college,
                        degree: pick(DEGREES),
                        fieldOfStudy: pick(BRANCHES),
                        startDate: new Date(`${pickRange(2019, 2024)}-08-01`),
                        endDate: e === 0 && Math.random() > 0.3 ? null : new Date(`${pickRange(2024, 2028)}-05-31`),
                        isCurrent: e === 0,
                        grade: `${(Math.random() * 2 + 7).toFixed(1)} CGPA`,
                        activities: pick([
                            'Coding Club, Robotics Club, IEEE Student Branch',
                            'ACM Chapter, Google DSC Lead, Hackathon Organizer',
                            'Technical Secretary, ML Research Group, Open Source Club',
                            'Cultural Committee, Web Dev Club, Photography Club',
                            'Sports Secretary, Drama Club, Student Council',
                        ]),
                        description: pick([
                            'Focused on software engineering and data structures.',
                            'Active in research and extracurricular technical activities.',
                            'Participated in multiple national-level competitions.',
                            'Led a team of developers building campus applications.',
                            'Specialized in AI/ML coursework with industry projects.',
                        ]),
                    },
                });
                eduCount++;
            } catch { /* skip */ }
        }
    }
    console.log(`  ✅ ${eduCount} education records\n`);

    // ─── 4. ADD EXPERIENCE (2–4 records per user) ──────────────────────
    console.log('  Adding 2–4 experience records per user...');
    let expCount = 0;
    for (const user of createdUsers) {
        const numExp = pickRange(2, 4);
        for (let e = 0; e < numExp; e++) {
            try {
                await prisma.experience.create({
                    data: {
                        userId: user.id,
                        title: pick(JOB_TITLES),
                        company: pick(COMPANIES),
                        type: pick(['Internship', 'Part-time', 'Freelance', 'Contract']),
                        location: pick(['Bangalore', 'Hyderabad', 'Remote', 'Mumbai', 'Delhi']),
                        startDate: randomDate(365, 90),
                        isCurrent: e === 0 && Math.random() > 0.5,
                        description: pick([
                            'Worked on building scalable features and collaborated with cross-functional teams.',
                            'Developed and deployed microservices handling 10K+ requests/min.',
                            'Built responsive UI components and improved page load by 40%.',
                            'Designed and implemented RESTful APIs with comprehensive test coverage.',
                            'Led a team of 3 interns on a customer-facing feature launch.',
                            'Implemented CI/CD pipelines and automated deployment processes.',
                            'Contributed to ML model optimization reducing inference time by 30%.',
                        ]),
                        skills: pickN(allSkillsFlat(), 3),
                    },
                });
                expCount++;
            } catch { /* skip */ }
        }
    }
    console.log(`  ✅ ${expCount} experience records\n`);

    // ─── 5. ADD PROJECTS (3–5 per user) ──────────────────────
    console.log('  Adding 3–5 projects per user...');
    let projCount = 0;
    for (const user of createdUsers) {
        const numProjects = pickRange(3, 5);
        const chosenProjects = pickN(PROJECT_NAMES, numProjects);
        for (let p = 0; p < chosenProjects.length; p++) {
            const projName = chosenProjects[p];
            try {
                await prisma.project.create({
                    data: {
                        userId: user.id,
                        name: projName,
                        description: pick(PROJECT_DESCRIPTIONS),
                        role: pick(['Lead Developer', 'Solo Project', 'Team Member', 'Co-Founder', 'Backend Lead', 'Frontend Lead']),
                        techStack: pickN(allSkillsFlat(), pickRange(3, 6)),
                        startDate: randomDate(400, 30),
                        endDate: Math.random() > 0.4 ? randomDate(29, 0) : undefined,
                        isCurrent: Math.random() > 0.6,
                        projectUrl: `https://${projName.toLowerCase().replace(/\s/g, '-')}.vercel.app`,
                        githubUrl: `https://github.com/${users[user.index].username}/${projName.toLowerCase().replace(/\s/g, '-')}`,
                        featured: p === 0,
                    },
                });
                projCount++;
            } catch { /* skip */ }
        }
    }
    console.log(`  ✅ ${projCount} project records\n`);

    // ─── 6. ADD ACHIEVEMENTS (2–3 per user) ──────────────────────
    console.log('  Adding 2–3 achievements per user...');
    let achieveCount = 0;
    for (const user of createdUsers) {
        const numAchieve = pickRange(2, 3);
        for (let a = 0; a < numAchieve; a++) {
        try {
            await prisma.achievement.create({
                data: {
                    userId: user.id,
                    title: pick(ACHIEVEMENT_TITLES),
                    type: pick(ACHIEVEMENT_TYPES),
                    organization: pick(ACHIEVEMENT_ORGS),
                    date: randomDate(730, 30),
                    description: pick([
                        'Competed against 500+ teams nationwide and secured top position.',
                        'Recognized for outstanding contribution and innovation in the field.',
                        'Selected based on academic merit and extracurricular activities.',
                        'Built a working prototype in 48 hours that impressed the judges.',
                        'Demonstrated exceptional problem-solving skills in a timed challenge.',
                    ]),
                },
            });
            achieveCount++;
        } catch { /* skip */ }
        }
    }
    console.log(`  ✅ ${achieveCount} achievement records\n`);

    // ─── 7. ADD CERTIFICATES (2–3 per user) ──────────────────────
    console.log('  Adding 2–3 certificates per user...');
    let certCount = 0;
    for (const user of createdUsers) {
        const numCerts = pickRange(2, 3);
        for (let c = 0; c < numCerts; c++) {
        try {
            await prisma.certificate.create({
                data: {
                    userId: user.id,
                    name: pick(CERT_NAMES),
                    issuingOrg: pick(CERT_ORGS),
                    issueDate: randomDate(365, 30),
                    doesNotExpire: Math.random() > 0.5,
                    credentialId: `CERT-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
                    credentialUrl: `https://www.credly.com/badges/${Math.random().toString(36).substring(2, 14)}`,
                },
            });
            certCount++;
        } catch { /* skip */ }
        }
    }
    console.log(`  ✅ ${certCount} certificate records\n`);

    // ─── 8. CREATE POSTS ──────────────────────────
    console.log('  Creating 100 posts...');
    const shuffledPosts = [...POST_CONTENTS].sort(() => Math.random() - 0.5);
    let postCount = 0;
    for (let i = 0; i < 100; i++) {
        const author = createdUsers[i % createdUsers.length];
        const content = shuffledPosts[i % shuffledPosts.length];
        try {
            await prisma.post.create({
                data: {
                    authorId: author.id,
                    type: 'text',
                    content,
                    visibility: 'public',
                    likesCount: pickRange(0, 50),
                    commentsCount: pickRange(0, 15),
                    createdAt: randomDate(30, 0),
                },
            });
            postCount++;
        } catch { /* skip */ }
    }
    console.log(`  ✅ Created ${postCount} posts\n`);

    // ─── 9. CREATE CONNECTIONS ──────────────────
    console.log('  Creating connections between users...');
    let connCount = 0;
    for (let i = 0; i < createdUsers.length - 1 && connCount < 120; i++) {
        for (let j = i + 1; j < createdUsers.length && connCount < 120; j++) {
            const a = createdUsers[i];
            const b = createdUsers[j];
            const shared = a.interests.filter(x => b.interests.includes(x));
            if (shared.length === 0) continue;
            if (Math.random() > 0.5 / shared.length) continue;
            try {
                await prisma.connections.create({
                    data: {
                        requesterId: a.id,
                        addresseeId: b.id,
                        status: Math.random() > 0.1 ? 'accepted' : 'pending',
                    },
                });
                connCount++;
            } catch { /* skip dupes */ }
        }
    }
    console.log(`  ✅ Created ${connCount} connections\n`);

    // ─── 10. CREATE ENGAGEMENT STREAKS ──────────────
    console.log('  Creating engagement streaks...');
    let streakCount = 0;
    for (const user of createdUsers) {
        try {
            const connStreak = pickRange(1, 15);
            const loginStreak = pickRange(1, 30);
            const postStreak = pickRange(0, 10);
            const msgStreak = pickRange(0, 8);
            await prisma.engagement_streaks.create({
                data: {
                    userId: user.id,
                    connectionStreak: connStreak,
                    loginStreak,
                    postingStreak: postStreak,
                    messagingStreak: msgStreak,
                    bestConnectionStreak: pickRange(connStreak, 20),
                    bestLoginStreak: pickRange(loginStreak, 45),
                    bestPostingStreak: pickRange(postStreak, 15),
                    bestMessagingStreak: pickRange(msgStreak, 12),
                    longestConnectionStreak: pickRange(connStreak, 20),
                    longestLoginStreak: pickRange(loginStreak, 45),
                    longestPostingStreak: pickRange(postStreak, 15),
                    longestMessagingStreak: pickRange(msgStreak, 12),
                    lastConnectionDate: randomDate(5, 0),
                    lastLoginDate: randomDate(2, 0),
                    lastPostDate: randomDate(10, 0),
                    lastMessageDate: randomDate(7, 0),
                    streakFreezes: pickRange(0, 3),
                    streakShieldActive: Math.random() > 0.7,
                },
            });
            streakCount++;
        } catch { /* skip */ }
    }
    console.log(`  ✅ ${streakCount} engagement streaks\n`);

    // ─── SUMMARY ──────────────────────────────────
    console.log('════════════════════════════════════════');
    console.log('  SEED COMPLETE — 100% PROFILES');
    console.log('════════════════════════════════════════');
    console.log(`  Users:          ${createdUsers.length}`);
    console.log(`  Skills:         ${skillCount}`);
    console.log(`  Education:      ${eduCount}`);
    console.log(`  Experience:     ${expCount}`);
    console.log(`  Projects:       ${projCount}`);
    console.log(`  Achievements:   ${achieveCount}`);
    console.log(`  Certificates:   ${certCount}`);
    console.log(`  Posts:           ${postCount}`);
    console.log(`  Connections:    ${connCount}`);
    console.log(`  Streaks:        ${streakCount}`);
    console.log(`\n  Password for all users: ${DEFAULT_PASSWORD}`);
    console.log('════════════════════════════════════════\n');
}

seed()
    .catch(e => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
