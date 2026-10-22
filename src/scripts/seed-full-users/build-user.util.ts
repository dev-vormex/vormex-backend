import { FIRST_NAMES, pick, LAST_NAMES, generateUsername, generateEmail, COLLEGES, BRANCHES, CITIES, pickN, INTEREST_POOLS, pickRange, BIOS, HEADLINES, DEGREES, randomDate } from "./prisma.util";

export // ──────────────────────────────────────────────
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
