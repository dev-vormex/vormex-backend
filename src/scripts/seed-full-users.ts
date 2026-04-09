/**
 * Seed script: Creates 100 users with 100% complete profiles.
 *
 * Every user gets:
 * - Full profile fields (bio, college, headline, location, interests, etc.)
 * - 6–10 universal skills (from all pools: frontend, backend, data, devops, etc.)
 * - 2–3 education records (multiple degrees)
 * - 2–4 experience records
 * - 3–5 projects with techStack
 * - 2–3 achievements
 * - 2–3 certificates
 * - UserStats record
 * - EngagementStreak record
 * - 100+ posts distributed across users
 * - ~120 connections between users
 * - Users distributed across 2–5 colleges only
 *
 * Run:  npx ts-node src/scripts/seed-full-users.ts
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const SALT = 10;
const DEFAULT_PASSWORD = 'Test@1234';

// ──────────────────────────────────────────────
// DATA POOLS
// ──────────────────────────────────────────────

const FIRST_NAMES = [
    'Aarav', 'Aditi', 'Aditya', 'Akash', 'Aman', 'Amita', 'Ananya', 'Anjali', 'Arjun', 'Ayesha',
    'Bhavya', 'Chaitanya', 'Deepak', 'Diya', 'Divya', 'Gaurav', 'Harini', 'Harsh', 'Ishaan', 'Isha',
    'Jatin', 'Kavya', 'Kiran', 'Kriti', 'Kunal', 'Lakshmi', 'Manav', 'Meera', 'Mohan', 'Nandini',
    'Neha', 'Nikhil', 'Nisha', 'Om', 'Pallavi', 'Pooja', 'Pranav', 'Priya', 'Rahul', 'Ravi',
    'Ritika', 'Rohan', 'Roshni', 'Sahil', 'Sakshi', 'Sandeep', 'Shreya', 'Siddharth', 'Simran', 'Sneha',
    'Suresh', 'Tanvi', 'Tejas', 'Varun', 'Vidya', 'Vikram', 'Vinay', 'Yamini', 'Zara', 'Arun',
    'Bharat', 'Charvi', 'Darshan', 'Ekta', 'Farhan', 'Gayatri', 'Hemant', 'Ira', 'Jayesh', 'Keerthi',
    'Lalit', 'Madhav', 'Navya', 'Omkar', 'Param', 'Radha', 'Sagar', 'Tanya', 'Uday', 'Vaishnavi',
    'Waris', 'Yash', 'Abhay', 'Bhavana', 'Chirag', 'Dhruv', 'Eesha', 'Firoz', 'Govind', 'Hema',
    'Ishan', 'Jhanvi', 'Kartik', 'Lata', 'Mira', 'Nitin', 'Oviya', 'Pavan', 'Reema', 'Shivam',
];

const LAST_NAMES = [
    'Sharma', 'Patel', 'Reddy', 'Kumar', 'Singh', 'Gupta', 'Verma', 'Joshi', 'Nair', 'Rao',
    'Mehta', 'Das', 'Iyer', 'Chopra', 'Malhotra', 'Agarwal', 'Saxena', 'Bhat', 'Mishra', 'Kulkarni',
    'Deshmukh', 'Pillai', 'Choudhary', 'Naidu', 'Menon', 'Hegde', 'Shetty', 'Tiwari', 'Pandey', 'Bansal',
    'Chauhan', 'Dutta', 'Kapoor', 'Rajan', 'Sethi', 'Tandon', 'Arora', 'Bhatt', 'Chandra', 'Goyal',
];

// 2–5 colleges only — users distributed across these for Find People / same-college features
const COLLEGES = [
    'IIT Bombay',
    'IIT Delhi',
    'BITS Pilani',
    'NIT Trichy',
    'VIT Vellore',
];

const BRANCHES = [
    'Computer Science', 'Electronics & Communication', 'Mechanical Engineering',
    'Electrical Engineering', 'Information Technology', 'Civil Engineering',
    'Data Science', 'AI & ML', 'Biotechnology', 'Chemical Engineering',
];

const DEGREES = ['B.Tech', 'B.E.', 'M.Tech', 'MCA', 'BCA', 'M.S.'];

const CITIES = ['Bangalore', 'Hyderabad', 'Mumbai', 'Delhi', 'Chennai', 'Pune', 'Kolkata', 'Jaipur', 'Ahmedabad', 'Lucknow'];

const SKILL_POOLS: Record<string, string[]> = {
    frontend: ['React', 'Next.js', 'Vue.js', 'Angular', 'Tailwind CSS', 'TypeScript', 'HTML/CSS', 'Svelte'],
    backend: ['Node.js', 'Express.js', 'Django', 'Flask', 'Spring Boot', 'FastAPI', 'NestJS', 'Go'],
    mobile: ['React Native', 'Flutter', 'Swift', 'Kotlin', 'Jetpack Compose', 'SwiftUI'],
    data: ['Python', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch', 'Scikit-Learn', 'SQL', 'R'],
    devops: ['Docker', 'Kubernetes', 'AWS', 'GCP', 'Azure', 'CI/CD', 'Terraform', 'Linux'],
    design: ['Figma', 'UI/UX Design', 'Adobe XD', 'Sketch', 'Photoshop'],
    blockchain: ['Solidity', 'Web3.js', 'Ethereum', 'Smart Contracts', 'Rust'],
    general: ['Git', 'REST APIs', 'GraphQL', 'MongoDB', 'PostgreSQL', 'Redis', 'Firebase'],
};

const INTEREST_POOLS: Record<string, string[]> = {
    coding: ['Web Development', 'Mobile Apps', 'Open Source', 'Competitive Programming', 'System Design'],
    ai: ['Artificial Intelligence', 'Machine Learning', 'Deep Learning', 'NLP', 'Computer Vision'],
    startup: ['Startups', 'Entrepreneurship', 'Product Management', 'Growth Hacking'],
    creative: ['UI/UX Design', 'Content Creation', 'Photography', 'Blogging', 'Video Editing'],
    career: ['Placement Prep', 'Internships', 'Resume Building', 'Interview Prep', 'DSA'],
    misc: ['Gaming', 'Finance', 'Crypto', 'Music', 'Travel', 'Reading', 'Fitness'],
};

const HEADLINES = [
    'Full Stack Developer | Open Source Enthusiast',
    'CS Undergrad | AI Researcher',
    'Building cool stuff with React & Node.js',
    'Aspiring SDE | DSA Grinder',
    'Flutter Developer | Mobile-first Thinker',
    'Data Science Intern @ Big Corp',
    'Competitive Programmer | 5★ CodeChef',
    'UI/UX Designer turned Developer',
    'Cloud Native Enthusiast | AWS Certified',
    'Backend Engineer | API Craftsman',
    'ML Engineer | Kaggle Expert',
    'Product Builder | Hackathon Winner',
    'DevOps Learner | Docker Fan',
    'Android Developer | Kotlin Lover',
    'MERN Stack Developer',
    'Exploring AI/ML | Python Nerd',
    'Open to collaborations!',
    'CS Student | Building side projects',
    'Web3 Explorer | Blockchain Dev',
    'Final Year | Looking for opportunities',
];

const BIOS = [
    "Passionate about building products that solve real problems. Love collaborating on hackathons.",
    "Currently learning Rust and building CLI tools. Previously interned at a YC startup.",
    "3rd year CS student who loves competitive programming and late-night coding sessions.",
    "Believer in open source. Contributed to multiple GSOC projects.",
    "Mobile app developer with 2 published apps on Play Store.",
    "Data science enthusiast. Running Kaggle kernels since freshman year.",
    "Love designing intuitive user experiences. Figma is my playground.",
    "Backend focused developer. Obsessed with system design and scalability.",
    "Currently building my startup in EdTech. Always up for a chat!",
    "ML researcher working on NLP. Published 2 papers in undergrad.",
    "Learning something new every day. Currently into Kubernetes and microservices.",
    "Hackathon addict — won 5 in the last 2 years. Love the energy!",
    "Aspiring product manager with a strong engineering background.",
    "Just vibing with code. Python by day, Rust by night.",
    "Part-time freelancer, full-time student. Building my portfolio.",
];

const COMPANIES = [
    'Google', 'Microsoft', 'Amazon', 'Flipkart', 'Swiggy', 'Razorpay', 'PhonePe',
    'Infosys', 'TCS', 'Wipro', 'Freshworks', 'Zoho', 'Juspay', 'CRED', 'Groww',
    'Ola', 'Meesho', 'Byju\'s', 'Paytm', 'Zerodha', 'Dream11', 'Unacademy',
];

const JOB_TITLES = [
    'SDE Intern', 'Frontend Developer Intern', 'Backend Developer Intern',
    'ML Engineer Intern', 'Data Science Intern', 'Full Stack Intern',
    'Research Intern', 'Android Developer Intern', 'DevOps Intern',
    'iOS Developer Intern', 'Cloud Engineer Intern', 'QA Engineer Intern',
];

const PROJECT_NAMES = [
    'Campus Connect', 'CodeBuddy', 'StudySync', 'DevDiary', 'HackTracker',
    'ResumeAI', 'QuizMaster', 'PortfolioBuilder', 'EventHub', 'MentorMatch',
    'BudgetBuddy', 'FitTrack', 'RecipeShare', 'TravelPlanner', 'BookClub',
    'CodeReview', 'SkillTree', 'TaskFlow', 'DataViz', 'ChatBot',
    'SmartNotes', 'EcoTracker', 'JobBoard', 'PeerLearn', 'CloudDash',
    'AITutor', 'DevOpsBot', 'InstaClone', 'GitInsights', 'PollMaster',
];

const PROJECT_DESCRIPTIONS = [
    'A web application for students to collaborate on projects and share resources.',
    'An AI-powered code review assistant that provides real-time suggestions.',
    'A real-time study group platform with video calls and shared whiteboards.',
    'A developer journal app to track learning progress and daily coding activities.',
    'A hackathon management platform for organizing and participating in events.',
    'An intelligent resume analyzer and builder powered by GPT-4.',
    'A gamified quiz platform with competitive multiplayer modes.',
    'A modern portfolio website generator with customizable templates.',
    'A campus event discovery and RSVP platform with social features.',
    'A mentorship matching app connecting students with industry professionals.',
    'A personal finance tracker with budget visualization and spending insights.',
    'A fitness tracking app with workout plans and progress analytics.',
    'A recipe sharing social network with meal planning features.',
    'A collaborative travel planning platform with itinerary sharing.',
    'A virtual book club app with reading challenges and discussions.',
];

const ACHIEVEMENT_TYPES = ['Hackathon', 'Competition', 'Award', 'Scholarship', 'Recognition'];
const ACHIEVEMENT_TITLES = [
    'Winner - Smart India Hackathon 2025',
    '1st Place - IEEE Coding Competition',
    'Best Innovation Award - TechFest 2025',
    'KVPY Scholar 2024',
    'Dean\'s List Recognition',
    'Google Code Jam Round 2 Qualifier',
    'Winner - HackWithInfy 2025',
    'ACM ICPC Regional Finalist',
    'Best Paper Award - Student Conference',
    'Microsoft Imagine Cup Semifinalist',
    'Amazon ML Challenge Top 50',
    'Best Project Award - Final Year',
    'Open Source Contributor of the Month',
    'National Merit Scholarship Recipient',
    'TCS CodeVita Grand Finalist',
];

const ACHIEVEMENT_ORGS = [
    'Government of India', 'IEEE', 'ACM', 'Google', 'Microsoft', 'Amazon',
    'TCS', 'Infosys', 'HackerEarth', 'HackerRank', 'CodeChef', 'LeetCode',
];

const CERT_NAMES = [
    'AWS Solutions Architect Associate',
    'Google Cloud Associate Cloud Engineer',
    'Microsoft Azure Fundamentals (AZ-900)',
    'Meta Frontend Developer Professional',
    'IBM Data Science Professional',
    'Google Data Analytics Professional',
    'AWS Cloud Practitioner',
    'Coursera Machine Learning Specialization',
    'MongoDB Developer Associate',
    'Kubernetes Administrator (CKA)',
    'HashiCorp Terraform Associate',
    'Cisco CCNA',
    'CompTIA Security+',
    'Deep Learning Specialization',
    'React Developer Certification',
];

const CERT_ORGS = [
    'Amazon Web Services', 'Google Cloud', 'Microsoft', 'Meta', 'IBM',
    'Coursera', 'MongoDB', 'CNCF', 'HashiCorp', 'Cisco', 'CompTIA', 'deeplearning.ai',
];

const POST_CONTENTS = [
    "Just deployed my first full-stack app to production! 🚀 Used Next.js + Express + PostgreSQL.",
    "Day 45 of #100DaysOfCode. Built a real-time chat app with Socket.io today.",
    "Hot take: Tailwind CSS > CSS Modules > Styled Components. Fight me. 😂",
    "Optimized our API response time from 2.3s to 180ms with Redis caching. Small wins! 🏆",
    "Started contributing to open source today. Submitted my first PR to a 10k+ star repo! 🤞",
    "The hardest part of DSA isn't the logic but explaining your approach in interviews.",
    "Just completed AWS Solutions Architect certification! 🎉 3 months of prep, totally worth it.",
    "Built a CLI tool in Rust that processes 1M records in <2 seconds. 🦀",
    "Unpopular opinion: README.md is the most important file in any repository.",
    "Excited to share that I'll be joining Google as an SDE Intern this summer! ✨",
    "Pro tip: Build projects > grinding LeetCode alone. Show what you've built.",
    "Our team won 1st place at the national hackathon! 48 hours of no sleep. 🏅",
    "Just open-sourced my college project — an AI-powered resume analyzer!",
    "Learned Docker and containerized my whole dev environment. Why didn't I do this sooner?",
    "The Python vs JavaScript debate is old. Learn both. 🐍⚡",
    "Working on a Flutter app for campus events. Hot reload is addictive.",
    "Interview tips: 1) Think aloud 2) Start brute force 3) Optimize 4) Test edge cases",
    "Finished 'Designing Data-Intensive Applications'. Best tech book ever. 📚",
    "Created my first neural network from scratch using only NumPy. 🧠",
    "PostgreSQL's full-text search is surprisingly powerful.",
    "The difference between junior and senior dev isn't code quality — it's knowing when NOT to code.",
    "Just set up a complete CI/CD pipeline with GitHub Actions. Magic. ✨",
    "Spent the weekend building a Wordle clone in React with multiplayer!",
    "Internships taught me more in 3 months than 2 years of lectures.",
    "Fixed a production bug by finding the exact issue on a 3-year-old GitHub thread. 🙏",
    "Exploring Web3 development. Built my first smart contract on Ethereum testnet.",
    "System design tip: Always start with requirements clarification.",
    "Finally understanding microservices vs monolith trade-offs after building both.",
    "Grateful for my tech community. The support during placements was everything. ❤️",
    "Built an expense tracker with React Native. First app with 500+ downloads! 📱",
    "TypeScript has ruined plain JavaScript for me. Type safety is addictive.",
    "Late nights with VS Code, lo-fi music, and chai. The programmer aesthetic. ☕",
    "Attended my first tech conference today. Networking was incredible!",
    "Pair programming > solo debugging. Two brains, one screen, zero bugs (almost). 👯",
    "Just completed the Stanford ML course. Andrew Ng is the GOAT. 🐐",
    "Kubernetes is overwhelming at first, but once you understand pods, it clicks.",
    "Published my first technical blog post! Writing solidifies understanding.",
    "Cracked FAANG interview after 6 months of prep. Consistency > intensity. 💪",
    "React Server Components are a game changer. The DX improvement is massive.",
    "ML isn't just about models. Data preprocessing takes 80% of the time. 😅",
    "Started mentoring juniors in DSA. Teaching is the best way to learn.",
    "GraphQL vs REST: both have their place. Use the right tool for the job.",
    "Our coding club just hit 500 members! So proud. 🎓",
    "Implemented a recommendation engine using collaborative filtering!",
    "TIL: git bisect can save hours of debugging. Binary search on commits? Genius.",
    "Built a real-time dashboard with WebSockets and D3.js. Data viz is underrated.",
    "Imposter syndrome hits hardest after joining a new team. You deserve to be there. 💫",
    "Migrated from MongoDB to PostgreSQL. Relational structures just made more sense.",
    "Contributing to Hacktoberfest for the 3rd year! Open source FTW! 🎃",
    "Python's asyncio is powerful but the learning curve is steep. 🐍",
    "Finally deployed my portfolio website. Simple, clean, and fast.",
    "Automated my standup notes with a Python script. Work smart. 😎",
    "The college-to-industry gap is real. Build projects, contribute to OSS, network.",
    "Just discovered htmx. Sometimes you don't need a JS framework.",
    "Database indexing is an art. A single index cut our query time by 95%.",
    "Studying system design for interviews. Designing Twitter is harder than using it. 😂",
    "Got my first freelance client! Building a complete web app.",
    "The best code is the code you didn't write. Abstractions are your friends.",
    "Failed my first interview but learned so much. Onward! 🚀",
    "Built a GitHub bot that auto-reviews PRs using GPT-4.",
    "Favorite stack: Next.js 14 + Prisma + PostgreSQL + Tailwind. Chef's kiss. 👨‍🍳",
    "Leetcode streak: 100 days. One problem a day keeps unemployment away. 📈",
    "Just wrapped my final year project — an AI chatbot for mental health. Tech for good! 💚",
    "Learned more from side projects than any course. Just start building.",
    "Debugging: 1) Shouldn't happen 2) Why? 3) Oh I see 4) How did this ever work?",
    "Tip: Use conventional commits. Future you will thank you.",
    "Just discovered Bun runtime. Incredibly fast. JS ecosystem keeps evolving!",
    "Finally understanding OAuth 2.0 after implementing it 3 times. Auth is a rabbit hole. 🕳️",
    "Weekend project: VS Code extension that tracks coding time. TypeScript + VS Code API FTW.",
    "Placements are stressful. Remember: one rejection is one redirection. Keep going! 💪",
    "Implemented JWT refresh token rotation. Security is fundamental. 🔐",
    "Just completed a 30-day open source challenge. Contributed to 15 repos!",
    "Built a Spotify clone with React and the Web Audio API. Music + Code = ❤️",
    "Machine learning pipelines are 90% data engineering, 10% modeling.",
    "Started a tech YouTube channel. First video hit 1K views! Content creation is fun.",
    "Terraform has changed how I think about infrastructure. IaC is essential.",
    "Just got my first contribution merged in a major OSS project. Feeling accomplished!",
    "The best debugger is a good night's sleep. Seriously.",
    "Conducted my first mock interview session. Helping others is rewarding.",
    "Built an API gateway from scratch with rate limiting and auth. Backend is art.",
    "Completed 500 problems on LeetCode. Quality > quantity though.",
    "Using Prisma ORM for the first time. Type-safe DB queries are a dream.",
    "Just launched my SaaS side project. $0 MRR but it's a start!",
    "Explored serverless with AWS Lambda + API Gateway. The future is event-driven.",
    "Docker Compose made my local dev setup reproducible. No more \"works on my machine\".",
    "Gave my first tech talk at college. Public speaking is a developer superpower.",
    "Implemented real-time notifications with SSE. Simpler than WebSockets for one-way data.",
    "Finished the CS50x course. David Malan is an amazing teacher.",
    "Built a Chrome extension for productivity tracking. 200+ installs!",
    "Switched from Vim to Neovim. The Lua config is chef's kiss.",
    "Just passed the Google Cloud Associate exam. Cloud skills are essential.",
    "Contributing to MDN Web Docs. Giving back to the resources that taught me.",
    "The Rust borrow checker is annoying at first, then you realize it saved you from bugs.",
    "WebAssembly is going to change web development. Running C++ in the browser!",
    "Set up monitoring with Grafana + Prometheus. Observability matters.",
    "Learning systems programming. Understanding how the OS works changes everything.",
    "Just got accepted into Google Summer of Code 2025! Dream come true. 🎉",
    "Built an e-commerce platform with Next.js and Stripe. Full-stack feels powerful.",
    "Code reviews are not about finding bugs — they're about knowledge sharing.",
    "Finally automated my deployment pipeline. Push to main = live in production.",
    "Started learning Go for backend services. The simplicity is refreshing.",
];

const PROFICIENCIES = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, arr.length));
}

function pickRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateUsername(first: string, last: string, index: number): string {
    const styles = [
        () => `${first.toLowerCase()}${last.toLowerCase()}${pickRange(1, 99)}`,
        () => `${first.toLowerCase()}_${last.toLowerCase().slice(0, 4)}`,
        () => `${first.toLowerCase()}${index}`,
        () => `${first.toLowerCase()}.${last.toLowerCase()}`,
        () => `the_${first.toLowerCase()}`,
    ];
    return pick(styles)();
}

function generateEmail(username: string): string {
    const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'protonmail.com', 'icloud.com'];
    return `${username}@${pick(domains)}`;
}

function randomDate(startDaysAgo: number, endDaysAgo: number): Date {
    const now = Date.now();
    const start = now - startDaysAgo * 86400000;
    const end = now - endDaysAgo * 86400000;
    return new Date(start + Math.random() * (end - start));
}

function allSkillsFlat(): string[] {
    return Object.values(SKILL_POOLS).flat();
}

// ──────────────────────────────────────────────
// BUILD FULL USER
// ──────────────────────────────────────────────

function buildUser(index: number, hash: string) {
    const firstName = FIRST_NAMES[index];
    const lastName = pick(LAST_NAMES);
    const name = `${firstName} ${lastName}`;
    const username = generateUsername(firstName, lastName, index);
    const email = generateEmail(username);
    const college = pick(COLLEGES);
    const branch = pick(BRANCHES);
    const city = pick(CITIES);

    // Pick 2-3 interest pools for rich overlap matching
    const poolKeys = pickN(Object.keys(INTEREST_POOLS), pickRange(2, 3));
    const interests = [...new Set(poolKeys.flatMap(k => pickN(INTEREST_POOLS[k], pickRange(2, 4))))];

    return {
        email,
        username,
        name,
        password: hash,
        profileImage: `https://api.dicebear.com/7.x/avataaars/png?seed=${username}`,
        bannerImageUrl: `https://api.dicebear.com/7.x/abstract/png?seed=${username}`,
        bio: pick(BIOS),
        college,
        branch,
        graduationYear: pickRange(2024, 2028),
        isVerified: true,
        headline: pick(HEADLINES),
        location: `${city}, India`,
        currentYear: pickRange(1, 4),
        degree: pick(DEGREES),
        portfolioUrl: `https://${username}.dev`,
        linkedinUrl: `https://linkedin.com/in/${username}`,
        isOpenToOpportunities: Math.random() > 0.3,
        interests,
        currentCity: city,
        lastActiveAt: randomDate(7, 0),
    };
}

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
