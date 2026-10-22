import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export const SALT = 10;

export const DEFAULT_PASSWORD = 'Test@1234';

export // ──────────────────────────────────────────────
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

export const LAST_NAMES = [
    'Sharma', 'Patel', 'Reddy', 'Kumar', 'Singh', 'Gupta', 'Verma', 'Joshi', 'Nair', 'Rao',
    'Mehta', 'Das', 'Iyer', 'Chopra', 'Malhotra', 'Agarwal', 'Saxena', 'Bhat', 'Mishra', 'Kulkarni',
    'Deshmukh', 'Pillai', 'Choudhary', 'Naidu', 'Menon', 'Hegde', 'Shetty', 'Tiwari', 'Pandey', 'Bansal',
    'Chauhan', 'Dutta', 'Kapoor', 'Rajan', 'Sethi', 'Tandon', 'Arora', 'Bhatt', 'Chandra', 'Goyal',
];

export // 2–5 colleges only — users distributed across these for Find People / same-college features
const COLLEGES = [
    'IIT Bombay',
    'IIT Delhi',
    'BITS Pilani',
    'NIT Trichy',
    'VIT Vellore',
];

export const BRANCHES = [
    'Computer Science', 'Electronics & Communication', 'Mechanical Engineering',
    'Electrical Engineering', 'Information Technology', 'Civil Engineering',
    'Data Science', 'AI & ML', 'Biotechnology', 'Chemical Engineering',
];

export const DEGREES = ['B.Tech', 'B.E.', 'M.Tech', 'MCA', 'BCA', 'M.S.'];

export const CITIES = ['Bangalore', 'Hyderabad', 'Mumbai', 'Delhi', 'Chennai', 'Pune', 'Kolkata', 'Jaipur', 'Ahmedabad', 'Lucknow'];

export const SKILL_POOLS: Record<string, string[]> = {
    frontend: ['React', 'Next.js', 'Vue.js', 'Angular', 'Tailwind CSS', 'TypeScript', 'HTML/CSS', 'Svelte'],
    backend: ['Node.js', 'Express.js', 'Django', 'Flask', 'Spring Boot', 'FastAPI', 'NestJS', 'Go'],
    mobile: ['React Native', 'Flutter', 'Swift', 'Kotlin', 'Jetpack Compose', 'SwiftUI'],
    data: ['Python', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch', 'Scikit-Learn', 'SQL', 'R'],
    devops: ['Docker', 'Kubernetes', 'AWS', 'GCP', 'Azure', 'CI/CD', 'Terraform', 'Linux'],
    design: ['Figma', 'UI/UX Design', 'Adobe XD', 'Sketch', 'Photoshop'],
    blockchain: ['Solidity', 'Web3.js', 'Ethereum', 'Smart Contracts', 'Rust'],
    general: ['Git', 'REST APIs', 'GraphQL', 'MongoDB', 'PostgreSQL', 'Redis', 'Firebase'],
};

export const INTEREST_POOLS: Record<string, string[]> = {
    coding: ['Web Development', 'Mobile Apps', 'Open Source', 'Competitive Programming', 'System Design'],
    ai: ['Artificial Intelligence', 'Machine Learning', 'Deep Learning', 'NLP', 'Computer Vision'],
    startup: ['Startups', 'Entrepreneurship', 'Product Management', 'Growth Hacking'],
    creative: ['UI/UX Design', 'Content Creation', 'Photography', 'Blogging', 'Video Editing'],
    career: ['Placement Prep', 'Internships', 'Resume Building', 'Interview Prep', 'DSA'],
    misc: ['Gaming', 'Finance', 'Crypto', 'Music', 'Travel', 'Reading', 'Fitness'],
};

export const HEADLINES = [
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

export const BIOS = [
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

export const COMPANIES = [
    'Google', 'Microsoft', 'Amazon', 'Flipkart', 'Swiggy', 'Razorpay', 'PhonePe',
    'Infosys', 'TCS', 'Wipro', 'Freshworks', 'Zoho', 'Juspay', 'CRED', 'Groww',
    'Ola', 'Meesho', 'Byju\'s', 'Paytm', 'Zerodha', 'Dream11', 'Unacademy',
];

export const JOB_TITLES = [
    'SDE Intern', 'Frontend Developer Intern', 'Backend Developer Intern',
    'ML Engineer Intern', 'Data Science Intern', 'Full Stack Intern',
    'Research Intern', 'Android Developer Intern', 'DevOps Intern',
    'iOS Developer Intern', 'Cloud Engineer Intern', 'QA Engineer Intern',
];

export const PROJECT_NAMES = [
    'Campus Connect', 'CodeBuddy', 'StudySync', 'DevDiary', 'HackTracker',
    'ResumeAI', 'QuizMaster', 'PortfolioBuilder', 'EventHub', 'MentorMatch',
    'BudgetBuddy', 'FitTrack', 'RecipeShare', 'TravelPlanner', 'BookClub',
    'CodeReview', 'SkillTree', 'TaskFlow', 'DataViz', 'ChatBot',
    'SmartNotes', 'EcoTracker', 'JobBoard', 'PeerLearn', 'CloudDash',
    'AITutor', 'DevOpsBot', 'InstaClone', 'GitInsights', 'PollMaster',
];

export const PROJECT_DESCRIPTIONS = [
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

export const ACHIEVEMENT_TYPES = ['Hackathon', 'Competition', 'Award', 'Scholarship', 'Recognition'];

export const ACHIEVEMENT_TITLES = [
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

export const ACHIEVEMENT_ORGS = [
    'Government of India', 'IEEE', 'ACM', 'Google', 'Microsoft', 'Amazon',
    'TCS', 'Infosys', 'HackerEarth', 'HackerRank', 'CodeChef', 'LeetCode',
];

export const CERT_NAMES = [
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

export const CERT_ORGS = [
    'Amazon Web Services', 'Google Cloud', 'Microsoft', 'Meta', 'IBM',
    'Coursera', 'MongoDB', 'CNCF', 'HashiCorp', 'Cisco', 'CompTIA', 'deeplearning.ai',
];

export const POST_CONTENTS = [
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

export const PROFICIENCIES = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];

export // ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function pickN<T>(arr: T[], n: number): T[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, arr.length));
}

export function pickRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateUsername(first: string, last: string, index: number): string {
    const styles = [
        () => `${first.toLowerCase()}${last.toLowerCase()}${pickRange(1, 99)}`,
        () => `${first.toLowerCase()}_${last.toLowerCase().slice(0, 4)}`,
        () => `${first.toLowerCase()}${index}`,
        () => `${first.toLowerCase()}.${last.toLowerCase()}`,
        () => `the_${first.toLowerCase()}`,
    ];
    return pick(styles)();
}

export function generateEmail(username: string): string {
    const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'protonmail.com', 'icloud.com'];
    return `${username}@${pick(domains)}`;
}

export function randomDate(startDaysAgo: number, endDaysAgo: number): Date {
    const now = Date.now();
    const start = now - startDaysAgo * 86400000;
    const end = now - endDaysAgo * 86400000;
    return new Date(start + Math.random() * (end - start));
}

export function allSkillsFlat(): string[] {
    return Object.values(SKILL_POOLS).flat();
}
