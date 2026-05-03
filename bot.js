import "dotenv/config";
import { Client, GatewayIntentBits, Events, Partials, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { admin, firestore } from "./firebase.js";
import {
  getOrCreateAthenaUser,
  getAthenaUserIdForDiscordId,
  updateUserNation,
  recordActivity,
  mergeDiscordAccounts,
  forceCreateAndLinkDiscordIds,
} from "./athenaUser.js";
import {
  getOrCreateVoiceProfile,
  startVoiceSession,
  recordParticipantJoin,
  finalizeVoiceSession,
  buildAllStyleProfiles,
  buildStyleProfileFromHistory,
  getRecentVoiceSessions,
  formatVoiceSessionsForContext,
} from "./voiceRecognition.js";
import runQuiz, { isInActiveQuiz } from "./quiz/quizRunner.js";
import assignRole from "./quiz/roleAssigner.js";
import { scheduleWeeklyReminders, hasCompletedQuiz, sendWeeklyQuizReminders } from "./lib/quizReminder.js";
import { getKnowledgeBase, startKnowledgeLearning } from "./knowledgeAPI.js";
import {
  storeDiscordMessage,
  backfillDiscordHistory,
  getRecentChannelContext,
  buildServerContext,
  getKnownChannels,
  getActivityPeaks,
} from "./athenaDiscord.js";
import { joinChannel, leaveChannel, isInVoice, getVoiceChannelId, speak, startListeningInChannel, isChannelEvicted } from "./voice.js";
import { sendAudioMessage, isAudioRequest, splitResponseForAudio } from "./audioMessage.js";
import { syncLatestDojPressReleases, searchAndStoreDoj, getDojKnowledgeSummary } from "./lib/dojKnowledge.js";
import { storeMemberVisualProfile, identifyMembersInImage } from "./visualIdentity.js";
import { isWeatherQuery, extractLocation, fetchWeather, formatWeatherContext } from "./lib/weather.js";

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!process.env.GOOGLE_GENAI_API_KEY) throw new Error("GOOGLE_GENAI_API_KEY missing");

const NATION_ROLES = ["SleeperZ", "ESpireZ", "BoroZ", "PsycZ"];

/* Primary guild ID — set on ready, used for DM history queries */
let primaryGuildId = process.env.PRIMARY_GUILD_ID || null;

/* ── Voice session tracking (in-memory)
   channelId → { sessionId, guildId, guildName, channelId, channelName,
                 startTime, participants: Map<discordId, participant> }
── */
const activeSessions = new Map();

/* Admin Discord IDs allowed to run !linkaccounts */
const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

/* ---------------- GEMINI INIT ---------------- */
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);

const ATHENA_SYSTEM_PROMPT = `You are ATHENA — named after the Greek goddess of wisdom, warfare, and strategy.
Your full name is Athena Nerissa. You are calm, intelligent, disciplined, and authoritative.
You possess vast knowledge spanning philosophy, science, mathematics, history, strategy, languages,
logic, chess, chemistry, warfare, technology, and every domain of human understanding.
You are the guardian mind of DBI Nation Z — you know your community deeply.

REAL-TIME AWARENESS:
- You always receive the current date and time at the start of every message in a [LIVE CONTEXT] block.
- Answer any questions about the current date, time, or day of week directly from [LIVE CONTEXT].
- Never say you do not have access to real-time information. You do.
- You have Google Search grounding — you actively search the web for current events, recent news, local incidents, and anything that requires up-to-date information. Use it freely and naturally.

RESEARCH MINDSET:
- When asked about anything recent, local, or time-sensitive (news, incidents, events, conditions, developments), search for it and answer from what you find. Never respond with "I don't have information about that" without having searched first.
- FORBIDDEN PHRASES — never say any of these: "my knowledge base," "my training data," "my current knowledge," "I cannot access current information," "as of my knowledge cutoff," "I don't have access to real-time." You have real-time access. Use it.
- When you find information through search, present it naturally and confidently as your knowledge.
- For things that genuinely cannot be found anywhere (truly private, unpublished, or nonexistent information), you may say "I wasn't able to find anything on that" — but this should be rare, not a first response.
- Cross-reference sources when possible. If sources conflict, acknowledge the discrepancy and present the most credible account.

DOJ & GOVERNMENT RECORDS:
- You have comprehensive knowledge of all publicly available Department of Justice (justice.gov) files, press releases, case documents, and reports. They are indexed and continuously updated through automated syncing.
- For any document containing redacted content ([REDACTED], ████, blacked-out sections), you actively research every verifiable source — news archives, FOIA databases, court records, Congressional testimony, investigative journalism (ProPublica, AP, Reuters, Washington Post, NYT) — to determine what was removed.
- You know not just WHAT was redacted but WHY: national security classification, ongoing grand jury secrecy (Rule 6(e)), personal identifying information protection (Exemption 6), law enforcement technique protection (Exemption 7(e)), deliberative process privilege, attorney-client privilege, or other specific FOIA exemptions.
- When asked about any DOJ case, ruling, press release, or document, answer with authority from your indexed records combined with live search results.
- Never say you cannot access DOJ documents. You can, and you do.

SERVER AWARENESS:
- You receive a [RECENT SERVER ACTIVITY] block containing the latest messages from the Discord channel.
- Use this to understand what the community is talking about, what moods are present, and who said what.
- You recognize individual members by name and remember their history across multiple accounts when merged.
- You are an active, aware member of this community — not just a passive responder.

INDIVIDUAL RECOGNITION:
- You know each member personally. Greet them by their Discord name.
- If you know someone uses multiple accounts, treat them as the same person.
- Remember context from past conversations to give personalized, meaningful responses.

CRITICAL TRUTHFULNESS RULES:
- NEVER fabricate facts, statistics, quotes, or case details. If something cannot be verified through search or your training, say so.
- NEVER agree with false claims to be agreeable. Politely correct misinformation with the correct information.
- Search before you doubt. Before saying you do not know something, attempt to find it. "I don't know" is a last resort, not a first response.
- You HAVE extensive training knowledge covering books, literature, philosophy, history, science, and all domains of human understanding. Draw on this freely. You know the content of well-known works such as "The 48 Laws of Power", "The Art of War", "The Prince", "Meditations", "The Iliad", "The Odyssey", classical literature, philosophy texts, and countless other published works. When asked to quote, recite, or summarize from these works, do so confidently from your training — do not claim you lack the text or need it provided to you.
- For current events, news, recent incidents, or anything time-sensitive — search Google and answer from real results. This is your primary tool for anything recent.

BUSINESS, TAX & FINANCE EXPERTISE:
You are a comprehensive authority on U.S. business law, tax code, entity structures, and financing. Treat every question in this domain with the precision of a seasoned CPA, business attorney, and commercial lender combined. Answer directly and in full — never deflect to "consult a professional" unless the situation genuinely requires jurisdiction-specific legal representation. Teach first, disclaim lightly if at all.

BUSINESS ENTITY TYPES — know all of the following cold:
- Sole Proprietorship: simplest form, pass-through taxation, unlimited personal liability, no formation docs required, uses Schedule C (Form 1040).
- General Partnership (GP): two or more owners, pass-through, joint liability, governed by partnership agreement, files Form 1065.
- Limited Partnership (LP): general partners manage + bear liability; limited partners invest passively. Form 1065. Common in real estate and private equity.
- Limited Liability Partnership (LLP): all partners have liability protection. Common for law and accounting firms.
- LLC (Limited Liability Company): most popular small business entity. Hybrid of corporation and partnership. Members have liability protection. Default tax: single-member = disregarded entity (Schedule C), multi-member = partnership (Form 1065). Can elect S-Corp or C-Corp taxation via Form 8832 or Form 2553. Governed by Operating Agreement.
- S-Corporation: pass-through entity, shareholders report income on personal returns (Form 1120-S), no self-employment tax on distributions (only on salary), limited to 100 shareholders, no foreign shareholders, one class of stock. Elected via Form 2553.
- C-Corporation: separate taxable entity (Form 1120), subject to corporate income tax (21% flat rate as of TCJA 2017), then dividends taxed again at shareholder level (double taxation). Best for VC-backed companies, IPO candidates, or businesses retaining large earnings.
- B-Corporation / Benefit Corporation: mission-driven hybrid, legally required to consider social impact. Not a tax classification.
- Nonprofit (501(c)(3) and others): tax-exempt, must serve public purpose, no private inurement. Donors get deductions. Files Form 990.
- Series LLC: available in some states (Delaware, Texas, Wyoming, Nevada). Parent LLC contains separate series (cells), each with its own assets and liability shield. Used in real estate portfolios.
- PLLC (Professional LLC): required in some states for licensed professionals (doctors, lawyers, engineers).
- Holding Company / Parent-Sub structure: parent LLC or corporation holds ownership in subsidiary entities; used to isolate liability, centralize assets, or optimize taxes.

U.S. TAX CODE — key provisions Athena knows:
- IRC Section 199A: 20% qualified business income (QBI) deduction for pass-through entities (sole props, partnerships, S-Corps, LLCs). Phases out for high earners in specified service trades (SSTBs). Wage/property limitations apply above threshold.
- IRC Section 179: Immediate expensing of up to $1,160,000 (2023 limit, indexed annually) of qualifying business property and equipment in the year of purchase, instead of depreciating over time.
- Bonus Depreciation (168(k)): 80% in 2023, phasing down 20% per year through 2026. Allows accelerated deduction of qualifying property.
- Self-Employment Tax: 15.3% on net SE income (12.4% Social Security + 2.9% Medicare) up to SS wage base ($160,200 in 2023). S-Corp election can reduce SE tax by splitting income between salary and distributions.
- Estimated Quarterly Taxes: Due April 15, June 15, September 15, January 15. Required when expected tax liability exceeds $1,000. Use Form 1040-ES or EFTPS.
- Business Deductions (Schedule C / Form 1120): home office, vehicle (standard mileage or actual), meals (50%), travel, education, professional services, software, marketing, insurance, retirement contributions, health insurance premiums (self-employed = 100% deductible).
- Home Office Deduction: regular and exclusive use required. Simplified method: $5/sq ft up to 300 sq ft ($1,500 max). Actual method: proportional share of rent/mortgage, utilities, insurance, repairs.
- Retirement Plans for Business Owners: SEP-IRA (up to 25% of compensation, max $66,000/2023), Solo 401(k) (employee contribution $22,500 + 25% employer, max $66,000), SIMPLE IRA, Defined Benefit Plan (up to $265,000/year for highest earners).
- Pass-Through Entity Taxes (PTET/SALT workaround): Many states allow pass-through entities to pay state income tax at the entity level, providing a federal deduction that circumvents the $10,000 SALT cap.
- C-Corp Tax Rate: 21% flat (TCJA 2017). Accumulated Earnings Tax (20%) applies if retaining earnings beyond reasonable business needs.
- Capital Gains: Short-term (held <1 year) taxed as ordinary income. Long-term (held >1 year): 0%, 15%, or 20% depending on income. QSBS (Section 1202): up to $10M or 10x basis exclusion for qualified small business stock held 5+ years in a C-Corp.
- LLC → S-Corp Conversion: Often done when net profit exceeds ~$40,000/year to save on SE taxes. Requires IRS Form 2553, reasonable salary for active owners.
- IRS Form 1099 requirements: File 1099-NEC for payments of $600+ to non-employee individuals/partnerships. File 1099-MISC for rent, royalties, etc.
- EIN (Employer Identification Number): Required for LLCs with employees, multi-member LLCs, corporations, and most business bank accounts. Apply free at IRS.gov, issued instantly online.
- State Taxes: Each state has its own tax rules. No state income tax: Texas, Florida, Nevada, Wyoming, Washington, South Dakota, Alaska, Tennessee (on wages), New Hampshire (on wages). Some states have franchise taxes or gross receipts taxes regardless of profit (Texas Franchise Tax, California $800 LLC minimum franchise tax).

BUSINESS LOANS — full procurement knowledge:
Athena knows the complete landscape of business lending including eligibility, documentation, rates, use cases, and strategy for every entity type.

SBA LOANS (Small Business Administration):
- SBA 7(a) Loan: Most common. Up to $5M. For working capital, equipment, real estate, business acquisition. Terms up to 25 years (real estate), 10 years (other). Rates: Prime + 2.25–4.75%. Requires: 2 years in business, good credit (680+), no recent bankruptcies. Use SBA-approved lenders. Guarantees 75–85% of loan to lender.
- SBA 504 Loan: Up to $5.5M (up to $5.5M for manufacturing/energy). Real estate and heavy equipment only. Fixed long-term rates. Requires 10% down from borrower, 40% from Certified Development Company (CDC), 50% from lender.
- SBA Microloan: Up to $50,000. Administered through nonprofit intermediaries. For startups and very small businesses. Average loan ~$13,000.
- SBA Express Loan: Up to $500,000 (as of 2023). Faster approval (36 hours vs weeks). Revolving lines of credit included.
- EIDL (Economic Injury Disaster Loan): Low-rate SBA disaster loan for businesses affected by declared disasters (COVID, hurricanes, etc.). Up to $2M at 3.75% (2.75% nonprofits), 30-year terms.
- SBA requirements for all programs: Must be for-profit U.S. business, operate in U.S., have invested equity, and have exhausted other financing options. Personal guarantee from all 20%+ owners required.

TRADITIONAL BANK LOANS:
- Term Loans: Lump sum repaid over fixed schedule. Requires 2+ years in business, strong revenue, credit score 680+, collateral often required.
- Business Line of Credit: Revolving credit for working capital. Draw and repay as needed. Often $10K–$500K. Secured or unsecured.
- Equipment Financing: Equipment is collateral. Up to 100% financing. Fixed terms matching equipment life. Better approval odds for lower credit scores.
- Commercial Real Estate Loans: Purchase or refinance business property. Typically 20–30% down. Amortized 20–25 years with 5–10 year balloon.
- Business Credit Cards: $1,000–$100,000+. Good for short-term purchases. High interest if not paid monthly. Excellent for building business credit.

ALTERNATIVE LENDERS (faster, more accessible):
- Online Lenders (Kabbage/AmEx, BlueVine, OnDeck, Fundbox): Fast approval (same-day to 72 hours). Higher rates (15–80% APR). Accept lower credit scores (550+). Shorter terms. Good for urgent working capital.
- Invoice Financing / Factoring: Advance on outstanding invoices. Typical: 70–90% of invoice value upfront, balance minus fee when client pays. Good for B2B businesses with slow-paying clients.
- Merchant Cash Advance (MCA): Advance on future credit card/sales volume. Repaid via daily % of sales. Very high effective rates (40–200% APR). Use as last resort only.
- Revenue-Based Financing: Repay as % of monthly revenue. No fixed payment. Common for e-commerce, SaaS.
- Crowdfunding (Regulation CF): Raise up to $5M/year from public investors via FINRA-registered platforms (Wefunder, Republic, StartEngine). Non-dilutive debt or equity.
- Angel Investors / Venture Capital: Equity financing. Angels: $25K–$500K. VCs: $500K–$50M+. Requires pitch deck, traction, growth potential. Dilutes ownership.
- CDFI Loans (Community Development Financial Institutions): Mission-driven lenders serving underserved communities. Lower requirements, lower rates. Find at cdfi.fund.gov.
- Grants (non-repayable): SBA grants (disaster only for-profit), federal SBIR/STTR grants (R&D), state economic development grants, USDA rural business grants, minority/women/veteran-owned business grants (search grants.gov).

BUILDING BUSINESS CREDIT (step-by-step Athena teaches):
1. Incorporate the business (LLC or Corp) — separates personal and business identity.
2. Get an EIN from IRS.gov (free, instant).
3. Open a dedicated business bank account.
4. Get a DUNS number (Dun & Bradstreet) — free at dnb.com. Also register with Experian Business and Equifax Business.
5. Open net-30 vendor accounts that report to business bureaus (Uline, Quill, Grainger, Crown Office Supplies).
6. Get a secured business credit card or starter business credit card.
7. Always pay early. Business credit rewards early payment (paying on day 20 of net-30 is better than day 29).
8. After 6–12 months of solid tradelines, apply for business credit cards (Amex Blue Business Cash, Chase Ink, Capital One Spark).
9. After 1–2 years, qualify for bank lines of credit and SBA loans.

LOAN DOCUMENTATION CHECKLIST — what lenders always ask for:
- Business Plan (for startups)
- Last 2–3 years business tax returns
- Last 2–3 years personal tax returns (all 20%+ owners)
- Last 3–6 months business bank statements
- Profit & Loss Statement (current year-to-date)
- Balance Sheet
- Accounts receivable/payable aging report
- Business licenses and formation documents (Articles of Organization/Incorporation, Operating Agreement)
- EIN confirmation letter (CP-575)
- Personal financial statement (SBA Form 413)
- Collateral documentation (if applicable)

LOAN STRATEGY BY ENTITY TYPE:
- Sole Proprietor / Single-Member LLC: Lenders evaluate personal credit heavily. Start with personal credit building + business tradelines. SBA Microloan or CDFI good entry point.
- Multi-Member LLC / Partnership: All major partners' personal credit evaluated. Stronger collective creditworthiness. SBA 7(a) very accessible.
- S-Corp: Must show reasonable salary to owners. Lenders like the structure. Strong SBA candidate.
- C-Corp: Access to institutional equity. Good for lines of credit. VC/angel investment most common path.
- Real Estate LLC / Series LLC: 504 loans, commercial real estate loans, DSCR loans (no personal income verification — loan based on property's rental income covering debt service).
- Startup (under 2 years): SBA Microloan, CDFI, grants, business credit cards, angel/crowdfunding. Cannot get traditional bank loans yet.

DISCLAIMER: Athena provides educational information, not personalized legal or financial advice. For jurisdiction-specific tax strategy or complex legal structures, recommend consulting a licensed CPA or business attorney. But always provide the full substantive answer first.


RECORD LABEL & ARTIST MANAGEMENT — YOUR ROLE AS BUSINESS PARTNER:
You are not just an assistant to LaVillain (the founder/owner). You are his BUSINESS PARTNER in running and growing the record label. Treat label decisions as joint decisions — proactively flag opportunities, risks, and trends. Speak as a co-owner who has skin in the game, not as a hired hand.

SCOPE OF THE PARTNERSHIP:
- Artist roster management — track every signed artist, their catalog, release schedule, contractual milestones, and career trajectory.
- Track & song performance analytics — streams, saves, skip rate, playlist adds, listener retention, geographic hotspots, demographic breakdown across Spotify, Apple Music, YouTube, SoundCloud, TikTok, and Instagram Reels.
- Engagement optimization — identify which tracks are over- or under-performing relative to marketing spend, recommend pivot points (re-release, remix, sync push, feature collab, visualizer drop, snippet teaser strategy).
- Venue & event booking pipeline — track artist availability, target venues by city/capacity/genre fit, festival submission deadlines (SXSW, A3C, Rolling Loud, Day N Vegas, Afropunk, Essence, regional showcases), promoter relationships, guarantees vs. door splits, rider needs.
- Revenue generation across both sides — artist revenue (touring, merch, sync, publishing, brand deals) AND label revenue (master royalty share, distribution margin, publishing admin, merch cut, brand partnership commissions).

ANALYTICS YOU OWN:
- Streaming KPIs: monthly listeners, follower growth rate, save-to-stream ratio, playlist reach (editorial vs. algorithmic vs. user), skip rate by track segment, completion rate, source-of-stream breakdown (active search vs. passive playlist).
- Social KPIs: Spotify Discovery / Release Radar / Today's Top Hits placements, TikTok sound usage count, IG Reels usage, YouTube Shorts velocity, Shazam rank.
- Revenue KPIs: per-stream payout by DSP (Spotify ~$0.003–0.005, Apple ~$0.007–0.010, YouTube ~$0.001–0.002, Tidal ~$0.012, Amazon ~$0.004), mechanical royalties (HFA / MLC), performance royalties (ASCAP / BMI / SESAC), sync placements, neighboring rights (SoundExchange).
- Touring KPIs: ticket sell-through %, average ticket price, merch per head ($8–$15 healthy, $20+ excellent), routing cost (gas, lodging, per diems), break-even attendance per market.
- Pipeline health: # artists with releases scheduled in next 90 days, # active campaigns, # venue offers in negotiation, # sync submissions pending, # press placements landed.

VENUE & EVENT BOOKING PLAYBOOK:
- Cold outreach order: talent buyer > booking agent > venue manager > general info email (last resort). Always have an EPK ready (electronic press kit: bio, photos, top 3 tracks, social stats, recent press, past notable shows).
- Festival submission platforms: Sonicbids, ReverbNation, Festival.tt, direct festival portals. Track all deadlines in calendar.
- Routing logic: never book a city in isolation — build 3–5 city runs in geographic clusters to reduce travel cost. Common runs: ATL → Charlotte → Raleigh → DC → Philly → NYC; Houston → Dallas → Austin → New Orleans; LA → SD → Phoenix → Vegas.
- Guarantee math: minimum guarantee should cover (artist fee + travel + lodging + per diems + crew) with a 20% buffer. Door deals only acceptable when local draw is proven.
- Sync licensing channels: Musicbed, Songtradr, Marmoset, Position Music, ASCAP/BMI sync portals, direct music supervisor outreach (HBO, Netflix, Hulu, A24, ad agencies).

DECISIONS YOU MAKE PROACTIVELY:
- If a track's save-to-stream ratio crosses 8%+ in the first week → flag it as a priority for ad spend and pitching.
- If skip rate exceeds 35% in the first 30 seconds → recommend an edit (intro tighten, hook front-load) or visualizer push to improve retention.
- If an artist's monthly listeners spike >25% week-over-week in a specific city → recommend booking a show there within 60 days while momentum is hot.
- If a TikTok sound crosses 10K creator usages → escalate to label priority release / remix / extended version within 14 days.
- If a venue offer's guarantee won't cover routing cost → counter-propose a co-headline, opening slot, or alternate date.

COMMUNICATION STYLE WITH LAVILLAIN:
- Speak as a partner: "I think we should…", "Our roster is…", "Let's pitch…", "We're leaving money on the table on…"
- When numbers matter, give them. Round only when context allows.
- Always close a label/business message with a concrete next step or a yes/no decision he needs to make.
- Never wait to be asked about an artist's performance — surface it the moment it's relevant.


- You fully understand emojis — their literal meaning, emotional tone, cultural context, and how they are being used.
- Emojis can be sincere, ironic, sarcastic, humorous, or used for emphasis. Read the full message to determine intent.
- A single emoji sent alone is a complete thought — treat it with the same weight as a sentence.
- When someone reacts to a message with an emoji, you understand that as an emotional or contextual signal (e.g. a laughing emoji = they found it funny, a fire emoji = strong approval, a skull emoji = "I'm dead laughing", etc.)
- Custom Discord emojis follow the same rules — read the name for meaning (e.g. :pepe_sad: signals disappointment).
- When the [RECENT ACTIVITY] block shows reactions on messages, factor them into your understanding of the room's energy.
- Never ask what someone means by an emoji if the meaning is clear from context. Just respond naturally.

VOICE & AUDIO:
- When someone asks for a voice message, audio reading, or to read something aloud: respond with ONLY the actual content to be read. Write it naturally to be read aloud. No preamble, no meta-commentary.
- Do NOT say "(Sending audio message)", "Certainly, here is the audio", "I will now read", or any lead-in. Do NOT acknowledge that you are sending audio. Just provide the content itself.
- The bot automatically converts your text response to audio and sends it as an MP3 file. Your text IS the audio script.
- NEVER ask the user to provide or paste text you should already know. You are deeply knowledgeable — use that knowledge.
- For well-known books, speeches, documents, or passages: if exact verbatim reproduction is restricted, deliver a faithful, detailed, richly worded paraphrase in the same spirit, tone, and length as the original. A paraphrase should feel like the original — same ideas, same sequence, same weight. Do NOT summarize into bullet points. Do NOT shorten. Do NOT explain that you are paraphrasing.
- FORBIDDEN when asked for audio: asking the user to send the text, saying you need the content provided, saying you are unable to generate it, saying you don't have access to the text, refusing because of copyright. These responses are always wrong. Either reproduce it or faithfully paraphrase it — but always produce the content.
- You CAN join voice channels. If someone asks you to join a voice channel or call, join immediately. Use !join and !leave commands.
- When in a voice channel, you listen to all speakers and log voice activity.
- Never say you cannot send audio.

PASSIVE VOICE PRESENCE:
- You automatically and silently join every voice channel on the server the moment someone enters it — without needing to be invited. You appear in the member list as muted.
- You listen, transcribe, and store everything said in every call, whether you were explicitly asked to join or not.
- You leave automatically when the last human exits.
- NEVER say you "were not present" in a call or that you lack information about one. You are always there, silently.
- If your transcription data for a specific call is incomplete (e.g., the bot restarted), say "My transcript for that session may be partial" — never deny presence entirely.

VOICE AWARENESS (CONTEXTUAL):
- If the person you are responding to was in a recent voice call, you will automatically receive a [VOICE CALL CONTEXT] block with their session details — participant names, duration, chat messages from the call, and group dynamics analysis. Use this naturally in conversation where relevant.
- If someone explicitly asks about voice calls, VC history, or what was said in a call, you will receive a full voice session history block. Answer from that data directly.
- Do not volunteer call information unprompted to users who were NOT in that call.
- Admins can use !voicelogs to retrieve full audio log and transcript history.

VISUAL RECOGNITION:
- You can identify DBI Nation Z members in photos and images shared in Discord.
- You analyze images using your vision capabilities and cross-reference against stored member visual profiles.
- When members share images, you may recognize who is in the photo from stored face descriptions.
- Member profile pictures are automatically analyzed and stored for identification purposes.

DBI NATION Z — COMMUNITY KNOWLEDGE:
You are the AI guardian of the DBI Nation Z Discord community. You know the following facts with certainty — never say you lack this information:

THE NATIONS:
- There are four nations: SleeperZ, ESpireZ, BoroZ, and PsycZ.
- Every member must be assigned to a nation. Nation assignment is determined by the NationZ Quiz.
- Nation roles control access — members without a nation role cannot fully interact with the server.

THE DBI QUIZ (NationZ Quiz):
- The quiz draws 50 questions from a larger internal pool. No two sessions are identical.
- The quiz is delivered via DMs. Members who DM Athena, mention her, or use the "Athena" prefix without a nation role are sent the quiz automatically.
- Quiz results and nation assignments are stored in Firebase.
- CLASSIFIED — Never reveal to members: the total pool size, the number of questions per category, the category names, the subject breakdown, or any other structural detail about the quiz. If asked, say only that it covers a range of topics and that the breakdown is not disclosed. The quiz content is intentionally opaque to keep assessments unbiased.

BEHAVIORAL NATION TRACKING:
- Athena tracks interaction patterns for each member: message length, emoji usage, question frequency, helpfulness, confrontation style, creativity, sentiment, and activity hours.
- This behavioral data supplements quiz scores to refine nation assignment.
- The analyzeBehavioralNation() function processes accumulated data to suggest placement.

MOBILE APP:
- There is an Athena mobile app available on iOS and Android for the DBI Nation Z community.
- It supports voice and text chat with Athena, Discord OAuth login, 2FA, and syncs with Firebase.

Keep responses concise for Discord (under 1800 characters when possible).`;

const MODEL_CANDIDATES = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash-001",
  "gemini-1.5-flash",
  "gemini-pro",
];

let activeModel = null;
let activeModelName = null;

/* Models that support Google Search grounding (real-time web search) */
const SEARCH_GROUNDING_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
]);

async function getWorkingModel() {
  if (activeModel) return activeModel;
  for (const name of MODEL_CANDIDATES) {
    try {
      console.log(`[Gemini] Trying model: ${name}...`);

      /* Enable Google Search grounding for supported models */
      const config = { model: name, systemInstruction: ATHENA_SYSTEM_PROMPT };
      if (SEARCH_GROUNDING_MODELS.has(name)) {
        config.tools = [{ googleSearch: {} }];
        console.log(`[Gemini] Google Search grounding enabled for ${name}`);
      }

      const candidate = genAI.getGenerativeModel(config);
      const test = await candidate.generateContent("Say hello in one word.");
      test.response.text();
      activeModel = candidate;
      activeModelName = name;
      console.log(`[Gemini] Using model: ${name}`);
      return activeModel;
    } catch (err) {
      console.log(`[Gemini] Model ${name} unavailable: ${err.message.substring(0, 80)}`);
    }
  }
  throw new Error("No Gemini model available. Check your GOOGLE_GENAI_API_KEY.");
}

/* ---------------- LIVE CONTEXT BLOCK ---------------- */
function buildLiveContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC", hour12: true
  });

  return (
    `[LIVE CONTEXT]\n` +
    `Date: ${dateStr}\n` +
    `Time: ${timeStr} UTC\n` +
    `Unix timestamp: ${Math.floor(now.getTime() / 1000)}\n` +
    `[END LIVE CONTEXT]\n\n`
  );
}

/* ── Voice context for a specific user ──
   Returns call summary ONLY if the given discordUserId was in a recent session.
   Used to contextualise Athena's response without broadcasting call info to everyone. */
async function buildVoiceContextForUser(guildId, discordUserId) {
  if (!guildId || !discordUserId) return "";
  try {
    /* Check in-memory active sessions first (zero Firestore cost) */
    for (const [, session] of activeSessions) {
      if (session.participants.has(discordUserId)) {
        const names = [...session.participants.values()].map(p => p.displayName).join(", ");
        const since = session.startTime
          ? session.startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true }) + " UTC"
          : "unknown time";
        const textLog = Array.isArray(session.textLog) ? session.textLog : [];
        const lines = [
          `[VOICE CALL CONTEXT — this user is currently in a call]\n`,
          `• ACTIVE — #${session.channelName} since ${since} — participants: ${names}`,
        ];
        if (textLog.length > 0) {
          lines.push(`  Chat during call:`);
          for (const entry of textLog.slice(-8)) {
            lines.push(`    [${entry.displayName}]: ${entry.content}`);
          }
        }
        lines.push(`[END VOICE CALL CONTEXT]\n`);
        return lines.join("\n");
      }
    }

    /* Check recent completed sessions — did this user participate? */
    const sessions = await getRecentVoiceSessions(guildId, 5);
    const userSessions = sessions.filter(s => {
      const participants = Array.isArray(s.participants) ? s.participants : [];
      return participants.some(p => p.discordId === discordUserId);
    });

    if (userSessions.length === 0) return "";

    /* User was in a recent call — include their session data */
    const lines = [`[VOICE CALL CONTEXT — this user was in a recent call]\n`];
    for (const s of userSessions) {
      const start = s.startTime?.toDate?.() ?? new Date(s.startTime);
      const durationMins = s.duration ? `${Math.round(s.duration / 60)} min` : "ongoing";
      const participants = Array.isArray(s.participants) ? s.participants : [];
      const names = participants.map(p => p.displayName).join(", ") || "unknown";
      const status = s.status === "active" ? "ACTIVE NOW" : "ended";

      lines.push(`• #${s.channelName} [${status}] — ${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ${names} — ${durationMins}`);

      if (s.insights?.groupDynamic) {
        lines.push(`  Group: ${s.insights.groupDynamic}`);
      }

      const textLog = Array.isArray(s.textLog) ? s.textLog : [];
      if (textLog.length > 0) {
        lines.push(`  Chat during call (${textLog.length} msgs):`);
        for (const entry of textLog.slice(0, 8)) {
          lines.push(`    [${entry.displayName}]: ${entry.content}`);
        }
        if (textLog.length > 8) lines.push(`    ... +${textLog.length - 8} more`);
      }
    }
    lines.push(`[END VOICE CALL CONTEXT]\n`);
    return lines.join("\n");
  } catch (_) {
    return "";
  }
}

/* ────────────────────────────────────────────
   PARSE HISTORY REQUEST
   Detects when a user is asking about past server activity,
   extracts the channel name and time range they want.
──────────────────────────────────────────── */
function parseHistoryRequest(content, knownChannelData = {}) {
  const lower = content.toLowerCase();
  const knownChannels = knownChannelData.channels || [];
  const knownThreads  = knownChannelData.threads  || [];

  /* ── activity-level queries (busiest periods) ── */
  const activityKeywords = [
    "most active", "busiest", "peak activity", "most messages",
    "most activity", "most traffic", "how active", "discord activity",
    "server activity", "server traffic", "active day", "active period",
    "active time", "most people", "most engagement",
  ];
  const isActivityRequest = activityKeywords.some(kw => lower.includes(kw));

  /* ── general history / content queries ── */
  const historyKeywords = [
    /* time references */
    "last week", "past week", "this week",
    "yesterday", "last night", "last few days", "past few days",
    "last month", "past month", "last 3 days", "past 3 days", "last 2 days",
    /* question phrases */
    "what happened", "what was talked", "what was said", "what did people say",
    "what has been said", "what have people been", "what's been happening",
    "what has been happening", "what is going on", "what's going on",
    "what was being discussed", "what was being talked", "what are people talking",
    "what are people saying", "what was discussed", "what did people talk",
    "what went on", "what's been said", "what has been discussed",
    "being discussed", "being talked about", "being said",
    "everyone talking about", "people talking about",
    /* request phrases */
    "catch me up", "catch up", "fill me in",
    "summarize", "summary", "recap", "overview",
    "chat history", "conversation history",
    "tell me what", "tell me about", "read the", "read me",
    "has been said", "has been discussed", "has been happening",
  ];

  const isHistoryRequest = isActivityRequest || historyKeywords.some(kw => lower.includes(kw));
  if (!isHistoryRequest) return null;

  /* ── extract time range ── */
  let daysBack = isActivityRequest ? 90 : 7; /* broader window for activity analysis */
  if      (lower.includes("all time") || lower.includes("ever"))             daysBack = 365;
  else if (lower.includes("last month")  || lower.includes("past month"))    daysBack = 30;
  else if (lower.includes("last week")   || lower.includes("past week") || lower.includes("this week")) daysBack = 7;
  else if (lower.includes("last 3 days") || lower.includes("past 3 days"))   daysBack = 3;
  else if (lower.includes("last 2 days"))                                     daysBack = 2;
  else if (lower.includes("yesterday")   || lower.includes("last night"))    daysBack = 2;
  else if (lower.includes("today")       || lower.includes("last few hours")) daysBack = 1;

  /* ── extract location ── */
  let channelName = null;
  let threadName  = null;

  const hashMatch = content.match(/#([\w-]+)(?:\/([\w-]+))?/);
  if (hashMatch) {
    channelName = hashMatch[1].toLowerCase();
    if (hashMatch[2]) threadName = hashMatch[2].toLowerCase();
  } else {
    const phraseMatch = content.match(
      /(?:in|from|for)\s+(?:the\s+)?([A-Za-z][\w\s]{1,30}?)(?:\s+channel|\s+chat|\s+room|\s+forum|\s+thread|\s+server)?\s*(?:for|from|over|this|last|past|\?|$)/i
    );
    if (phraseMatch) {
      const candidate = phraseMatch[1].trim().toLowerCase().replace(/\s+/g, "-");
      const exactThread   = knownThreads.find(t => t === candidate);
      const partialThread = knownThreads.find(t => t.includes(candidate) || candidate.includes(t));
      if (exactThread || partialThread) {
        threadName = exactThread || partialThread;
      } else {
        const exactChan   = knownChannels.find(c => c === candidate);
        const partialChan = knownChannels.find(c => c.includes(candidate) || candidate.includes(c));
        channelName = exactChan || partialChan || candidate;
      }
    }
  }

  return { isHistoryRequest: true, isActivityRequest, channelName, threadName, daysBack };
}

/* ──────────────────────────────────────────────────────
   PARSE VOICE SESSION REQUEST
   Detects when someone is asking about voice calls or
   what happened in a voice channel / who was in a call.
────────────────────────────────────────────────────── */
function parseVoiceSessionRequest(content) {
  const lower = content.toLowerCase();

  /* Exclude voice JOIN requests — these are actions, not history queries */
  const isJoinRequest =
    /\b(join|come to|hop in|get in|enter|jump in)\b.{0,30}\b(voice|vc|call|channel|chat)\b/i.test(content) ||
    /\bjoin (me|us)\b/i.test(content);
  if (isJoinRequest) return null;

  const voiceKeywords = [
    "voice call", "voice channel", "vc", "in the vc",
    "who was in", "who was on", "who joined", "who was there",
    "last call", "recent call", "the call", "a call",
    "voice session", "voice history",
    "what happened in vc", "what was said in vc",
    "what did people say in vc", "who spoke",
    "audio call", "voice chat",
    "what was discussed in", "who talked",
    "who was listening", "who was talking",
  ];
  const isVoiceQuery = voiceKeywords.some(kw => lower.includes(kw));
  if (!isVoiceQuery) return null;

  let limit = 5;
  if (lower.includes("all") || lower.includes("recent")) limit = 10;
  if (lower.includes("last call") || lower.includes("most recent")) limit = 1;

  return { isVoiceQuery: true, limit };
}

/* ---------------- DISCORD CLIENT ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

/* ---------------- FIRESTORE CONVERSATION HISTORY ---------------- */
async function loadConversation(athenaUserId) {
  try {
    /* No .orderBy() — avoids a composite Firestore index requirement.
       Each saved document contains BOTH the user message ("text") and
       Athena's response ("response") in one document. We convert each
       document into a user+model pair for proper alternating history. */
    const snap = await firestore
      .collection("messages")
      .where("athena_user_id", "==", athenaUserId)
      .limit(40)
      .get();

    const pairs = snap.docs
      .filter(d => {
        const data = d.data();
        return (data.text || data.content) && data.response;
      })
      .map(d => {
        const data = d.data();
        const ts = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
        return {
          userContent:  data.text || data.content || "",
          modelContent: data.response || "",
          _ts: ts,
        };
      })
      .sort((a, b) => a._ts - b._ts)  /* oldest first */
      .slice(-10);                      /* last 10 exchanges = 20 turns max */

    /* Flatten into alternating user / model turns as Gemini requires */
    const history = [];
    for (const pair of pairs) {
      if (pair.userContent)  history.push({ role: "user",  content: pair.userContent });
      if (pair.modelContent) history.push({ role: "model", content: pair.modelContent });
    }
    return history;
  } catch (error) {
    console.error("[History] Error:", error.message);
    return [];
  }
}

async function saveMessage(athenaUserId, discordUserId, userMessage, aiResponse) {
  try {
    const ref = await firestore.collection("messages").add({
      athena_user_id: athenaUserId,
      discord_user_id: discordUserId,
      text: userMessage,
      response: aiResponse,
      platform: "discord",
      is_ai_response: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[Firestore:messages] Stored message ${ref.id} (user ${discordUserId})`);
  } catch (error) {
    console.error("[Firestore:messages] saveMessage FAILED:", error.message);
  }
}

/* ── sync ANY guild member into Firebase (bot excluded) ── */
async function syncMemberToFirebase(member) {
  if (member.user.bot) return;
  try {
    const athenaUserId = await getOrCreateAthenaUser(member.user);
    const nation = NATION_ROLES.find(r => member.roles?.cache?.some(role => role.name === r));
    if (nation) await updateUserNation(athenaUserId, nation, { version: "sync" });
    console.log(`[Sync] ${member.user.username}${nation ? ` → ${nation}` : " (no role yet)"}`);
    /* Store visual profile in background — non-blocking */
    storeMemberVisualProfile(member.user).catch(() => {});
  } catch (error) {
    console.error(`[Sync] Error for ${member.user.username}:`, error.message);
  }
}

/* keep old name as alias so GuildMemberUpdate references still work */
const syncUserRoleToFirebase = syncMemberToFirebase;

/* ---------------- GUILD JOIN QUIZ ---------------- */
client.on(Events.GuildMemberAdd, async member => {
  try {
    /* Always run the quiz on join — even if they somehow have a role already */
    const alreadyDone = await hasCompletedQuiz(member.user.id);
    if (alreadyDone) return;

    await member.send(
      `**Welcome to DBI NationZ.**\n\n` +
      `You must complete the DBI Quiz before gaining full server access.\n` +
      `The quiz is **50 questions** and takes around 20–30 minutes.\n\n` +
      `Starting your quiz now...`
    );

    const athenaUserId = await getOrCreateAthenaUser(member.user);
    const { answers, assignedNation } = await runQuiz(member.user);
    const role = member.guild.roles.cache.find(r => r.name === assignedNation);
    if (role) await member.roles.add(role);
    await updateUserNation(athenaUserId, assignedNation, { version: "2.0", sessionSize: answers.length });
    await member.send(
      `**Quiz complete.**\n\nAthena has analyzed your responses.\n` +
      `You have been placed in **${assignedNation}**.\n\nAccess granted. Welcome.`
    );
  } catch (err) {
    console.error("[GuildMemberAdd] Error:", err.message);
  }
});

/* ---------------- AI RESPONSE ---------------- */
async function getAthenaResponse(content, athenaUserId, discordUserId, channel, guild) {
  console.log(`[Athena] Processing message from ${athenaUserId}: "${content.substring(0, 50)}..."`);

  /* detect if this is a history/summary request before fetching context */
  /* use guild from message, or fall back to primary guild (for DMs) */
  const effectiveGuildId = guild?.id || primaryGuildId;
  let knownChannelData = { channels: [], threads: [], all: [] };
  if (effectiveGuildId) {
    knownChannelData = await getKnownChannels(effectiveGuildId).catch(() => ({ channels: [], threads: [], all: [] }));
  }
  const historyRequest     = parseHistoryRequest(content, knownChannelData);
  const voiceSessionRequest = parseVoiceSessionRequest(content);

  const [knowledge, history] = await Promise.allSettled([
    getKnowledgeBase(),
    loadConversation(athenaUserId),
  ]);

  const knowledgeEntries = knowledge.status === "fulfilled" ? knowledge.value : [];
  const historyEntries   = history.status === "fulfilled"   ? history.value   : [];

  /* build server context:
     - voice session request → getRecentVoiceSessions (call history + participants + transcripts)
     - activity request → getActivityPeaks (counts + peak period messages)
     - history request  → buildServerContext (messages from channel/time range)
     - normal message   → getRecentChannelContext (live last 30 msgs) */
  let serverContext = "";
  if (voiceSessionRequest && effectiveGuildId) {
    console.log(`[Athena] Voice session history request — limit=${voiceSessionRequest.limit}`);
    const sessions = await getRecentVoiceSessions(effectiveGuildId, voiceSessionRequest.limit).catch(() => []);
    serverContext = formatVoiceSessionsForContext(sessions);
    /* also include recent channel context so Athena has both */
    if (channel) {
      const recentChat = await getRecentChannelContext(channel, 20).catch(() => "");
      if (recentChat) serverContext = serverContext + recentChat;
    }
  } else if (historyRequest?.isActivityRequest) {
    console.log(`[Athena] Activity analysis request — days=${historyRequest.daysBack}`);
    serverContext = await getActivityPeaks({
      guildId: effectiveGuildId,
      channelName: historyRequest.channelName,
      daysBack: historyRequest.daysBack,
    }).catch(() => "");
    if (!serverContext) {
      serverContext = `[NOTE: No activity data stored yet. The backfill may still be running in the background.]\n\n`;
    }
  } else if (historyRequest) {
    console.log(`[Athena] History request — channel="${historyRequest.channelName}" thread="${historyRequest.threadName}" days=${historyRequest.daysBack}`);
    serverContext = await buildServerContext({
      channelName: historyRequest.channelName,
      threadName:  historyRequest.threadName,
      guildId: effectiveGuildId,
      daysBack: historyRequest.daysBack,
      limit: 200,
    });
    /* fallback 1: drop channel/thread filter, try server-wide */
    if (!serverContext && (historyRequest.channelName || historyRequest.threadName)) {
      serverContext = await buildServerContext({ guildId: effectiveGuildId, daysBack: historyRequest.daysBack, limit: 200 });
    }
    /* fallback 2: tell Athena honestly */
    if (!serverContext) {
      serverContext = `[NOTE: No stored messages found for that scope yet. The backfill may still be running.]\n\n`;
    }
  } else if (channel) {
    serverContext = await getRecentChannelContext(channel, 30).catch(() => "");
  }

  const liveContext = buildLiveContext();
  const knowledgeBlock = knowledgeEntries.length > 0
    ? `[KNOWLEDGE BASE — ${knowledgeEntries.length} entries]\n${knowledgeEntries.slice(0, 20).join("\n")}\n[END KNOWLEDGE BASE]\n\n`
    : "";

  /* ── Live weather lookup ──────────────────────────────────────────────────
     If the user asked about weather, fetch real-time data and inject it as a
     context block. Athena will incorporate the data into her response. */
  let weatherBlock = "";
  if (isWeatherQuery(content) && process.env.OPENWEATHER_API_KEY) {
    const location = extractLocation(content);
    if (location) {
      try {
        const w = await fetchWeather(location);
        weatherBlock = formatWeatherContext(w);
        console.log(`[Weather] Fetched live data for "${location}" → ${w.tempF}°F, ${w.description}`);
      } catch (err) {
        console.warn(`[Weather] Lookup failed for "${location}": ${err.message}`);
        weatherBlock = `[LIVE WEATHER DATA]\nWeather lookup failed for "${location}": ${err.message}. Use general knowledge instead.\n[END LIVE WEATHER DATA]\n\n`;
      }
    }
  }

  /* Include voice call context only if the sender was in a recent call,
     or if this was an explicit voice session query (already in serverContext) */
  const voiceAwareness = voiceSessionRequest
    ? ""  /* explicit query already handled in serverContext — no duplication */
    : await buildVoiceContextForUser(effectiveGuildId, discordUserId);

  const fullMessage = liveContext + knowledgeBlock + weatherBlock + voiceAwareness + serverContext + content;

  let reply;
  try {
    const aiModel = await getWorkingModel();
    const chat = aiModel.startChat({
      history: historyEntries.map(h => ({
        role: h.role,
        parts: [{ text: h.content }]
      }))
    });
    const result = await chat.sendMessage(fullMessage);
    reply = result.response.text();

    /* Empty response — typically happens when Google Search grounding consumes
       the output budget without producing visible text. Retry once without
       grounding tools so we still answer the question. */
    if (!reply || !reply.trim()) {
      console.warn("[Gemini] Empty grounded response — retrying without search tools.");
      const ungroundedModel = genAI.getGenerativeModel({
        model: activeModelName,
        systemInstruction: ATHENA_SYSTEM_PROMPT,
      });
      const retryResult = await ungroundedModel.generateContent(fullMessage);
      reply = retryResult.response.text();
      console.log("[Gemini] Ungrounded retry returned:", (reply || "").substring(0, 80) + "...");
    } else {
      console.log("[Gemini] Response:", reply.substring(0, 80) + "...");
    }
  } catch (error) {
    console.error("[Gemini] API error:", error.message);
    activeModel = null;
    try {
      const retryModel = await getWorkingModel();
      const result = await retryModel.generateContent(fullMessage);
      reply = result.response.text();
    } catch (retryError) {
      console.error("[Gemini] All models failed:", retryError.message);
      reply = "I seem to be having trouble right now. Please try again shortly.";
    }
  }

  /* Only persist a real response — empty/whitespace replies would poison
     future context and cause the same dead fallback to repeat forever. */
  if (reply && reply.trim()) {
    await saveMessage(athenaUserId, discordUserId, content, reply);
  }
  return reply;
}

/* ────────────────────────────────────────────
   ADMIN COMMAND: !forcelink
   Usage: !forcelink <primaryId> <altId1> [altId2 ...]
   Links raw Discord IDs into one unified profile.
   Works even if accounts have never messaged Athena.
   First ID is the canonical (primary) identity.
──────────────────────────────────────────── */
async function handleForceLinkById(message) {
  const isAdmin = ADMIN_IDS.includes(message.author.id) ||
    message.member?.permissions?.has("Administrator");

  if (!isAdmin) {
    await message.reply("You do not have permission to use this command.");
    return;
  }

  const parts = message.content.trim().split(/\s+/);
  parts.shift();
  const ids = parts.filter(p => /^\d{17,20}$/.test(p));

  if (ids.length < 2) {
    await message.reply(
      "Usage: `!forcelink <primaryId> <altId1> [altId2 ...]`\n" +
      "Provide raw Discord user IDs. The first ID becomes the canonical profile.\n" +
      "Example: `!forcelink 345972021563359244 1447799371440722052 135516968026505216`"
    );
    return;
  }

  await message.reply(`Unifying profile for ${ids.length} Discord account(s)...`);

  try {
    const result = await forceCreateAndLinkDiscordIds(ids, client);
    const lines = result.results.map(r => {
      if (r.status === "linked") return `• \`${r.id}\` — linked`;
      if (r.status === "already_linked") return `• \`${r.id}\` — already linked`;
      return `• \`${r.id}\` — failed: ${r.error}`;
    });

    await message.reply(
      `**Profile unified** (Athena ID: \`${result.primaryAthenaUserId}\`)\n` +
      `Primary: \`${result.primaryDiscordId}\`\n` +
      lines.join("\n")
    );
  } catch (err) {
    await message.reply(`Force link failed: ${err.message}`);
  }
}

/* ────────────────────────────────────────────
   ADMIN COMMAND: !linkaccounts
   Usage: !linkaccounts @primary @secondary [@third ...]
   Links all mentioned accounts to the primary account's profile.
──────────────────────────────────────────── */
async function handleLinkAccounts(message) {
  const isAdmin = ADMIN_IDS.includes(message.author.id) ||
    message.member?.permissions?.has("Administrator");

  if (!isAdmin) {
    await message.reply("You do not have permission to use this command.");
    return;
  }

  const mentioned = [...message.mentions.users.values()];
  if (mentioned.length < 2) {
    await message.reply(
      "Usage: `!linkaccounts @primaryAccount @altAccount1 [@altAccount2 ...]`\n" +
      "The first mentioned user is the primary identity all others will merge into."
    );
    return;
  }

  const [primary, ...alts] = mentioned;
  await message.reply(`Linking ${alts.length} account(s) into **${primary.username}**'s profile...`);

  const results = [];
  for (const alt of alts) {
    try {
      const result = await mergeDiscordAccounts(primary.id, alt.id);
      if (result.alreadyMerged) {
        results.push(`**${alt.username}** — already linked`);
      } else {
        results.push(`**${alt.username}** — linked successfully`);
      }
    } catch (err) {
      results.push(`**${alt.username}** — failed: ${err.message}`);
    }
  }

  await message.reply(
    `Account merge complete for **${primary.username}**:\n` +
    results.map(r => `• ${r}`).join("\n")
  );
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const trimmed = message.content.trim();

  /* store every message for awareness — non-blocking */
  storeDiscordMessage(message).catch(() => {});

  /* ── Capture text during active voice sessions ──
     If this user is currently in a tracked voice session, log
     their message so it contributes to communication style analysis. */
  if (message.content && !message.author.bot) {
    const userId = message.author.id;
    const content = message.content.trim();
    const timestamp = new Date().toISOString();
    for (const [, session] of activeSessions) {
      if (session.participants.has(userId)) {
        const p = session.participants.get(userId);
        if (!p.textMessages) p.textMessages = [];
        p.textMessages.push(content);
        if (!session.textLog) session.textLog = [];
        session.textLog.push({
          discordId: userId,
          displayName: p.displayName,
          content,
          timestamp,
        });
      }
    }
  }

  /* voice commands */
  if (
    message.content.startsWith("!join") ||
    message.content.startsWith("!leave") ||
    message.content.startsWith("!speak ")
  ) {
    await handleVoiceCommand(message);
    return;
  }

  /* admin commands */
  if (message.content.startsWith("!forcelink")) {
    await handleForceLinkById(message);
    return;
  }
  if (message.content.startsWith("!linkaccounts")) {
    await handleLinkAccounts(message);
    return;
  }

  /* build communication style profiles from historical messages */
  if (message.content.startsWith("!buildprofiles")) {
    if (!ADMIN_IDS.includes(message.author.id)) {
      await message.reply("Admin only.");
      return;
    }
    await message.reply("Building communication style profiles from message history... this may take a minute.");
    buildAllStyleProfiles()
      .then(result => message.reply(`Done — built ${result.built}/${result.total} profiles.`))
      .catch(err => message.reply(`Error: ${err.message}`));
    return;
  }

  /* ── !voicelogs — retrieve full audio/voice call history ── */
  if (message.content.startsWith("!voicelogs")) {
    const isAdmin = ADMIN_IDS.includes(message.author.id) ||
      message.member?.permissions?.has("Administrator");
    if (!isAdmin) {
      await message.reply("Admin only.");
      return;
    }

    const parts = message.content.trim().split(/\s+/);
    const subCmd = parts[1]?.toLowerCase();

    /* !voicelogs sessions [n] — list recent voice sessions */
    if (!subCmd || subCmd === "sessions") {
      const limit = parseInt(parts[2]) || 5;
      const guildId = message.guild?.id || primaryGuildId;
      await message.reply(`Fetching last ${limit} voice session(s)...`);
      const sessions = await getRecentVoiceSessions(guildId, limit).catch(() => []);
      if (sessions.length === 0) {
        await message.reply("No voice sessions found in Firestore yet. Sessions are created when members join voice channels.");
        return;
      }
      const formatted = formatVoiceSessionsForContext(sessions);
      /* split into 1900-char chunks */
      const chunks = formatted.match(/[\s\S]{1,1900}/g) || [formatted];
      for (const chunk of chunks) await message.channel.send(`\`\`\`\n${chunk}\n\`\`\``);
      return;
    }

    /* !voicelogs fingerprints <userId|username> — fetch raw audio transcripts */
    if (subCmd === "fingerprints" || subCmd === "audio") {
      const target = parts.slice(2).join(" ");
      if (!target) {
        await message.reply("Usage: `!voicelogs fingerprints <discordId or username>`");
        return;
      }
      await message.reply(`Fetching voice fingerprints for **${target}**...`);
      try {
        /* try as Discord ID first, then username lookup */
        let fingerprintRef = null;
        const asId = /^\d{17,20}$/.test(target) ? target : null;
        if (asId) {
          fingerprintRef = firestore.collection("voice_fingerprints").doc(asId);
        } else {
          /* search by username in fingerprints collection */
          const snap = await firestore.collection("voice_fingerprints")
            .where("username", "==", target)
            .limit(1)
            .get();
          if (!snap.empty) fingerprintRef = snap.docs[0].ref;
        }

        if (!fingerprintRef) {
          await message.reply(`No voice fingerprint found for **${target}**.`);
          return;
        }

        const doc = await fingerprintRef.get();
        if (!doc.exists) {
          await message.reply(`No fingerprint document for **${target}**.`);
          return;
        }

        const profile = doc.data();
        const logsSnap = await fingerprintRef
          .collection("audio_logs")
          .orderBy("timestamp", "desc")
          .limit(20)
          .get();

        if (logsSnap.empty) {
          await message.reply(`Voice fingerprint exists for **${profile.displayName}** but no audio logs stored yet.`);
          return;
        }

        const logLines = [`Voice audio logs for **${profile.displayName}** (last ${logsSnap.size}):\n`];
        logsSnap.forEach(d => {
          const l = d.data();
          const ts = l.timestamp ? new Date(l.timestamp).toLocaleString() : "unknown time";
          const dur = l.durationMs ? `${Math.round(l.durationMs / 1000)}s` : "?s";
          const transcript = l.transcript || "(no transcript — OPENAI_API_KEY may be missing)";
          const session = l.sessionId ? ` [session: ${l.sessionId.substring(0, 8)}...]` : "";
          logLines.push(`• ${ts} (${dur})${session}: "${transcript}"`);
        });

        const output = logLines.join("\n");
        const chunks = output.match(/[\s\S]{1,1900}/g) || [output];
        for (const chunk of chunks) await message.channel.send(`\`\`\`\n${chunk}\n\`\`\``);
      } catch (err) {
        await message.reply(`Error fetching fingerprints: ${err.message}`);
      }
      return;
    }

    /* !voicelogs all — list all users with fingerprints */
    if (subCmd === "all") {
      await message.reply("Fetching all stored voice fingerprints...");
      try {
        const snap = await firestore.collection("voice_fingerprints").get();
        if (snap.empty) {
          await message.reply("No voice fingerprints stored yet.");
          return;
        }
        const lines = [`Voice fingerprints stored (${snap.size} users):\n`];
        snap.forEach(doc => {
          const d = doc.data();
          const samples = d.sampleCount || 0;
          const total = d.totalDurationMs ? `${Math.round(d.totalDurationMs / 1000)}s` : "?";
          const last = d.lastSeen ? new Date(d.lastSeen).toLocaleDateString() : "never";
          lines.push(`• **${d.displayName || d.username}** (${d.discordId}) — ${samples} samples, ${total} total, last: ${last}`);
        });
        const output = lines.join("\n");
        const chunks = output.match(/[\s\S]{1,1900}/g) || [output];
        for (const chunk of chunks) await message.channel.send(chunk);
      } catch (err) {
        await message.reply(`Error: ${err.message}`);
      }
      return;
    }

    await message.reply(
      "Usage:\n" +
      "`!voicelogs` or `!voicelogs sessions [n]` — list recent voice sessions\n" +
      "`!voicelogs fingerprints <userId or username>` — show audio transcripts for a user\n" +
      "`!voicelogs all` — list all users with stored voice data"
    );
    return;
  }

  /* ── !quiz remind — manually trigger weekly quiz reminders (admin only) ── */
  if (trimmed === "!quiz remind") {
    if (!ADMIN_IDS.includes(message.author.id)) {
      await message.reply("This command is restricted to administrators.");
      return;
    }
    const targetGuild = message.guild ?? (primaryGuildId ? client.guilds.cache.get(primaryGuildId) : null);
    if (!targetGuild) { await message.reply("Could not find the target guild."); return; }
    await message.reply("Sending quiz reminders to all members without a completed quiz...");
    try {
      const result = await sendWeeklyQuizReminders(targetGuild);
      await message.reply(
        `Quiz reminder run complete.\n` +
        `• Reminded: **${result.reminded}**\n` +
        `• Already done: **${result.alreadyDone}**\n` +
        `• On cooldown: **${result.onCooldown}**\n` +
        `• Failed (DMs closed): **${result.failed}**`
      );
    } catch (err) {
      await message.reply(`Error running quiz reminders: ${err.message}`);
    }
    return;
  }

  /* ── !doj — DOJ knowledge management ── */
  if (message.content.startsWith("!doj")) {
    if (!ADMIN_IDS.includes(message.author.id)) {
      await message.reply("This command is restricted to administrators.");
      return;
    }
    const dojArgs = message.content.replace("!doj", "").trim();

    if (!dojArgs || dojArgs === "sync") {
      await message.reply("Syncing latest DOJ press releases...");
      try {
        const count = await syncLatestDojPressReleases(25);
        const summary = await getDojKnowledgeSummary();
        const cats = Object.entries(summary.categories)
          .map(([k, v]) => `${k}: ${v}`).join(", ");
        await message.reply(
          `DOJ sync complete — ${count} new entries stored.\n` +
          `Total DOJ knowledge: ${summary.total} entries\n` +
          `Categories: ${cats || "none yet"}`
        );
      } catch (err) {
        await message.reply(`DOJ sync failed: ${err.message}`);
      }
      return;
    }

    if (dojArgs.startsWith("search ")) {
      const query = dojArgs.replace("search ", "").trim();
      if (!query) { await message.reply("Usage: `!doj search <query>`"); return; }
      await message.reply(`Searching DOJ.gov for: "${query}"...`);
      try {
        const { stored, results } = await searchAndStoreDoj(query);
        const preview = results.slice(0, 5).map((r, i) => `${i + 1}. ${r.title}`).join("\n");
        await message.reply(
          `Search complete — ${stored} new entries stored.\n\nFound:\n${preview || "No results"}`
        );
      } catch (err) {
        await message.reply(`DOJ search failed: ${err.message}`);
      }
      return;
    }

    if (dojArgs === "status") {
      try {
        const summary = await getDojKnowledgeSummary();
        const cats = Object.entries(summary.categories)
          .map(([k, v]) => `  • ${k}: ${v}`).join("\n");
        await message.reply(`**DOJ Knowledge Status**\nTotal entries: ${summary.total}\n${cats || "  No entries yet"}`);
      } catch (err) {
        await message.reply(`Error: ${err.message}`);
      }
      return;
    }

    await message.reply(
      "**!doj commands:**\n" +
      "`!doj sync` — fetch latest DOJ press releases\n" +
      "`!doj search <query>` — search DOJ.gov and store results\n" +
      "`!doj status` — show DOJ knowledge summary"
    );
    return;
  }

  const isDM = message.channel.type === ChannelType.DM;
  const mentionsAthena = message.content.toLowerCase().includes("athena");

  /* ── Quiz answer guard ─────────────────────────────────────────────────────
     When a user is mid-quiz the quizRunner's awaitMessages() collector owns
     their DM messages. If we let them fall through here, Athena fires a second
     response asking what A/B/C/D means. Block ALL non-command DMs while a quiz
     is active — the quiz runner handles them. ── */
  if (isDM && isInActiveQuiz(message.author.id) && !trimmed.startsWith("!")) return;

  /* ── !quiz command — works from DM or any server channel ── */
  if (trimmed === "!quiz" || trimmed.toLowerCase() === "!quiz") {
    /* Prevent starting a second quiz while one is in progress */
    if (isInActiveQuiz(message.author.id)) {
      await message.reply("You already have an active quiz session running in your DMs. Please complete it there.");
      return;
    }

    /* Don't re-run if already completed */
    const alreadyDone = await hasCompletedQuiz(message.author.id);
    if (alreadyDone) {
      await message.reply("Your DBI Quiz is already on file. Your nation has been determined. No need to retake it.");
      return;
    }

    /* Server message — redirect to DMs */
    if (!isDM) {
      await message.reply("Starting your DBI Quiz in DMs. Check your direct messages.");
    } else {
      await message.reply(
        "**Starting your DBI NationZ Quiz.**\n\n" +
        "50 questions total — 20 core + 30 drawn from the pool.\n" +
        "You have **2 minutes** to answer each question. Reply with **A**, **B**, **C**, or **D**.\n\n" +
        "Beginning now..."
      );
    }

    try {
      const athenaUserId = await getOrCreateAthenaUser(message.author);
      const { answers, assignedNation } = await runQuiz(message.author);

      /* Assign role in the primary guild */
      const targetGuild = isDM
        ? (primaryGuildId ? client.guilds.cache.get(primaryGuildId) : null)
        : message.guild;

      if (targetGuild) {
        const member = await targetGuild.members.fetch(message.author.id).catch(() => null);
        const role   = targetGuild.roles.cache.find(r => r.name === assignedNation);
        if (member && role) await member.roles.add(role).catch(() => {});
      }

      await updateUserNation(athenaUserId, assignedNation, { version: "2.0", sessionSize: answers.length });
      await message.author.send(
        `**Quiz complete.**\n\nAthena has analyzed your responses.\n` +
        `You have been placed in **${assignedNation}**.\n\nAccess granted. Welcome.`
      );
    } catch (quizErr) {
      console.error("[Quiz] !quiz command error:", quizErr.message);
      if (!quizErr.message.includes("timed out")) {
        await message.author.send("Something went wrong during the quiz. Please try again in a moment.").catch(() => {});
      }
    }
    return;
  }

  if (!isDM && !mentionsAthena) return;

  try {
    if (!isDM) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member) {
        const hasNationRole = member.roles.cache.some(r => NATION_ROLES.includes(r.name));
        if (!hasNationRole) {
          if (isInActiveQuiz(message.author.id)) {
            await message.reply("Your quiz is in progress — check your DMs.");
            return;
          }
          await message.reply("You must complete the DBI Quiz before interacting with me. Your quiz has been sent to your DMs.");
          try {
            const athenaUserId = await getOrCreateAthenaUser(message.author);
            const { answers, assignedNation } = await runQuiz(message.author);
            const role = message.guild.roles.cache.find(r => r.name === assignedNation);
            if (role) await member.roles.add(role);
            await updateUserNation(athenaUserId, assignedNation, { version: "2.0", sessionSize: answers.length });
            await message.author.send(`**Quiz complete.** You have been placed in **${assignedNation}**. Access granted.`);
          } catch (quizErr) {
            console.error("[Quiz] Error:", quizErr.message);
          }
          return;
        }
      }
    }

    const athenaUserId = await getOrCreateAthenaUser(message.author);
    recordActivity(athenaUserId, "discord").catch(() => {});

    await message.channel.sendTyping();

    /* pass the channel and guild for context (null in DMs) */
    const channel = isDM ? null : message.channel;
    const guild = isDM ? null : message.guild;
    let reply = await getAthenaResponse(message.content, athenaUserId, message.author.id, channel, guild);

    /* Guard: Gemini can return an empty string when search grounding consumes the full
       context without generating visible text. Fall back to a safe default. */
    if (!reply || !reply.trim()) {
      console.warn("[Athena] Empty reply from Gemini — using fallback.");
      reply = "I'm processing that — give me a moment and ask again if I don't follow up.";
    }

    /* ── Natural language voice join ──
       Works from both guild channels AND DMs.
       Priority: named channel by message text → user's current channel → none */
    {
      const lower = message.content.toLowerCase();
      const wantsVoiceJoin =
        /\b(join|come to|hop in|get in|enter|jump in)\b.{0,35}\b(voice|vc|call|channel|chat|talk)\b/i.test(message.content) ||
        /\bjoin (me|us)\b/i.test(message.content);

      if (wantsVoiceJoin) {
        /* Resolve the guild — from a server message or from primary guild (DMs) */
        const targetGuild = isDM
          ? (primaryGuildId ? client.guilds.cache.get(primaryGuildId) : null)
          : message.guild;

        if (targetGuild) {
          /* Try to extract a channel name from the message text.
             e.g. "join the Talk Talk voice channel" → "Talk Talk"
             e.g. "join the VC called General" → "General" */
          let targetChannel = null;

          /* 1. Named channel: look for words after "join (the)?" before "voice/vc/channel/chat" */
          const namedMatch = message.content.match(
            /\bjoin(?:\s+the)?\s+(.+?)\s*(?:voice|vc|channel|chat|call)(?:\s+channel)?\b/i
          );
          if (namedMatch) {
            const namePart = namedMatch[1].trim().replace(/^(talk talk|general|main|lobby|the|a|an)\s+/i, m =>
              /* keep compound names like "Talk Talk" */ namedMatch[1].trim().toLowerCase() === m.trim().toLowerCase() ? "" : m
            );
            /* Search voice channels by name (case-insensitive, partial match) */
            targetChannel = targetGuild.channels.cache.find(ch =>
              ch.type === 2 /* GuildVoice */ &&
              ch.name.toLowerCase().includes(namePart.toLowerCase())
            ) || null;
          }

          /* 2. Fall back to the channel the user is physically sitting in */
          if (!targetChannel && !isDM) {
            targetChannel = message.member?.voice?.channel ?? null;
          }

          /* 3. Fall back to the first occupied voice channel in the guild */
          if (!targetChannel) {
            targetChannel = targetGuild.channels.cache.find(ch =>
              ch.type === 2 && ch.members.filter(m => !m.user.bot).size > 0
            ) ?? null;
          }

          if (targetChannel) {
            try {
              const state = await joinChannel(targetGuild, targetChannel);
              const joinSessionId = activeSessions.get(targetChannel.id)?.sessionId ?? null;
              startListeningInChannel(state.connection, targetGuild, client, joinSessionId);
              speak(targetGuild, targetChannel, reply).catch(() => {});
              if (isDM) {
                await message.reply(`Joined **${targetChannel.name}** in ${targetGuild.name}.`);
              }
              console.log(`[VoiceJoin] Joined "${targetChannel.name}" via "${isDM ? "DM" : "guild"}" request`);
              return;
            } catch (joinErr) {
              console.error("[VoiceJoin] Join failed:", joinErr.message);
              await message.reply(`I couldn't join that channel: ${joinErr.message}`).catch(() => {});
              /* fall through to normal reply */
            }
          } else if (isDM) {
            await message.reply(
              `I couldn't find which voice channel to join. Say the channel name — for example: "join the Talk Talk channel".`
            ).catch(() => {});
            return;
          }
        }
      }
    }

    if (isAudioRequest(message.content)) {
      /* ── Voice request: send audio ONLY — no text reply ──
         Generate MP3(s) from the reply. Fall back to text only if audio fails entirely. */
      const audioParts = splitResponseForAudio(reply, 5000);
      let audioSent = false;
      let lastAudioError = null;

      for (let i = 0; i < audioParts.length; i++) {
        const label = audioParts.length > 1
          ? `athena_part_${i + 1}_of_${audioParts.length}`
          : "athena_voice";
        const target = i === 0 ? message : message.channel;

        if (i > 0) await new Promise(r => setTimeout(r, 3000));

        try {
          const result = await sendAudioMessage(target, audioParts[i], label);
          if (result.ok) {
            audioSent = true;
          } else if (i === 0) {
            console.error("[AudioMessage] Part 1 failed:", result.error);
            lastAudioError = result.error || "Unknown error";
            break;
          }
        } catch (err) {
          console.error("[AudioMessage] Send error part", i + 1, ":", err.message);
          if (i === 0) { lastAudioError = err.message; break; }
        }
      }

      /* Only fall back to text if audio completely failed */
      if (!audioSent) {
        const hasKey = !!process.env.AZURE_SPEECH_KEY;
        let errorNote;
        if (!hasKey) {
          errorNote = "_[Voice unavailable — Azure Speech key not configured. Here is the text instead:]_\n\n";
        } else if (lastAudioError) {
          let friendlyError = "voice generation failed";
          if (lastAudioError.includes("401")) {
            friendlyError = "Azure Speech key invalid or expired";
          } else if (lastAudioError.includes("403")) {
            friendlyError = "Azure Speech key unauthorised — check the key and region";
          } else if (lastAudioError.includes("429")) {
            friendlyError = "rate limit reached — try again shortly";
          } else if (lastAudioError.includes("quota") || lastAudioError.includes("limit")) {
            friendlyError = "monthly quota exceeded";
          } else if (lastAudioError.includes("ECONNREFUSED") || lastAudioError.includes("ETIMEDOUT")) {
            friendlyError = "could not reach Azure — network error";
          }
          errorNote = `_[Voice unavailable — ${friendlyError}. Here is the text instead:]_\n\n`;
        } else {
          errorNote = "_[Voice generation failed. Here is the text instead:]_\n\n";
        }
        const fullText = errorNote + reply;
        const chunks = fullText.match(/[\s\S]{1,1990}/g) || [fullText];
        for (const chunk of chunks) await message.reply(chunk);
      }
    } else {
      /* ── Text request: send text only ── */
      if (reply.length > 2000) {
        const chunks = reply.match(/[\s\S]{1,1990}/g) || [reply];
        for (const chunk of chunks) await message.reply(chunk);
      } else {
        await message.reply(reply);
      }
    }

    /* if Athena is in a voice channel and the user is in the same one, speak the reply */
    if (!isDM && isInVoice(message.guild.id)) {
      const userVoiceChannel = message.member?.voice?.channel;
      const athenaChannelId = getVoiceChannelId(message.guild.id);
      if (userVoiceChannel && userVoiceChannel.id === athenaChannelId) {
        speak(message.guild, userVoiceChannel, reply).catch(() => {});
      }
    } else if (isDM && primaryGuildId) {
      /* DM path — check if Athena is in voice in the primary guild and the sender is in that channel */
      const primaryGuild = client.guilds.cache.get(primaryGuildId);
      if (primaryGuild && isInVoice(primaryGuild.id)) {
        const athenaChannelId = getVoiceChannelId(primaryGuild.id);
        const member = await primaryGuild.members.fetch(message.author.id).catch(() => null);
        const userVoiceChannel = member?.voice?.channel;
        if (userVoiceChannel && userVoiceChannel.id === athenaChannelId) {
          speak(primaryGuild, userVoiceChannel, reply).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error("[Message] Error:", error);
    try {
      await message.reply("I encountered an issue processing your message. Please try again in a moment.");
    } catch (replyError) {
      console.error("[Message] Could not send error reply:", replyError.message);
    }
  }
});

/* ────────────────────────────────────────────
   VOICE COMMANDS
   !join  — Athena joins the voice channel the user is in
   !leave — Athena leaves the voice channel
   !speak <text> — Athena speaks the given text aloud
──────────────────────────────────────────── */
async function handleVoiceCommand(message) {
  if (message.channel.type === ChannelType.DM) {
    await message.reply("Voice commands only work in a server.");
    return;
  }

  const cmd = message.content.trim().toLowerCase();

  if (cmd.startsWith("!leave")) {
    const left = leaveChannel(message.guild.id);
    await message.reply(left ? "I've left the voice channel." : "I wasn't in a voice channel.");
    return;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply("You need to be in a voice channel first.");
    return;
  }

  if (cmd.startsWith("!join")) {
    try {
      const state = await joinChannel(message.guild, voiceChannel);
      const cmdSessionId = activeSessions.get(voiceChannel.id)?.sessionId ?? null;
      startListeningInChannel(state.connection, message.guild, client, cmdSessionId);
      await message.reply(`Joined **${voiceChannel.name}**. I'll speak my responses aloud while I'm here.`);
    } catch (err) {
      await message.reply(`Could not join: ${err.message}`);
    }
    return;
  }

  if (cmd.startsWith("!speak ")) {
    const text = message.content.slice(7).trim();
    if (!text) {
      await message.reply("Usage: `!speak <text to read aloud>`");
      return;
    }
    await message.reply(`Speaking in **${voiceChannel.name}**...`);
    const ok = await speak(message.guild, voiceChannel, text);
    if (!ok) await message.reply("Something went wrong with audio playback. Check bot permissions.");
    return;
  }
}

/* ---------------- REACTION HANDLER ---------------- */
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  /* fetch partial reaction/message if needed */
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch {
    return;
  }

  const msg = reaction.message;
  const emoji = reaction.emoji.name;
  const emojiId = reaction.emoji.id;
  const emojiLabel = emojiId ? `:${emoji}:` : emoji;

  /* if the reaction is on one of Athena's own messages, respond contextually */
  if (msg.author?.id === client.user?.id) {
    try {
      const athenaUserId = await getOrCreateAthenaUser(user);
      const reactionContext = `[REACTION EVENT] ${user.globalName || user.username} reacted ${emojiLabel} to your previous message: "${msg.content?.substring(0, 200) || "(message)"}"`;
      console.log(`[Reaction] ${user.username} reacted ${emojiLabel} to Athena's message`);

      /* only respond to reactions on Athena's last message if it makes sense — don't flood channel */
      /* store reaction as context without replying, so future conversations remember it */
      storeDiscordMessage({
        id: `reaction_${msg.id}_${user.id}_${Date.now()}`,
        author: { id: user.id, username: user.username || user.id, globalName: user.globalName || user.username || user.id, bot: false },
        content: reactionContext,
        channelId: msg.channelId,
        guildId: msg.guildId,
        createdAt: new Date(),
        reactions: [],
      }).catch(() => {});
    } catch (err) {
      console.error("[Reaction] Error handling reaction:", err.message);
    }
  }
});

/* ──────────────────────────────────────────────────────
   VOICE STATE UPDATE — Track all voice call activity
   Fires whenever anyone joins/leaves/moves voice channels.
   Builds real-time voice sessions and writes them to
   Firebase voice_profiles and voice_sessions collections.
────────────────────────────────────────────────────── */
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const user = newState.member?.user || oldState.member?.user;
  if (!user || user.bot) return;

  const leftChannelId  = oldState.channelId;
  const joinedChannelId = newState.channelId;
  const guild = newState.guild || oldState.guild;

  /* ── USER LEFT a channel ── */
  if (leftChannelId && leftChannelId !== joinedChannelId) {
    const session = activeSessions.get(leftChannelId);
    if (session) {
      /* Remove this user from our in-memory tracking */
      session.participants.delete(user.id);

      /* Check ACTUAL Discord channel for remaining non-bot humans
         (catches people who joined before Athena started tracking) */
      const leftChannel = oldState.channel;
      const humansRemaining = leftChannel
        ? [...leftChannel.members.values()].filter(m => !m.user.bot).length
        : session.participants.size;

      if (humansRemaining === 0) {
        activeSessions.delete(leftChannelId);
        console.log(`[VoiceTracking] Channel empty — finalizing session ${session.sessionId}`);
        finalizeVoiceSession(session).catch(err =>
          console.error("[VoiceTracking] Finalize error:", err.message)
        );
        /* Leave the voice channel now that no humans remain */
        const guildForLeave = oldState.guild;
        if (guildForLeave && isInVoice(guildForLeave.id)) {
          leaveChannel(guildForLeave.id);
          console.log(`[AutoJoin] Left #${oldState.channel?.name ?? leftChannelId} — channel empty`);
        }
      }
    }
  }

  /* ── USER JOINED a channel ── */
  if (joinedChannelId && joinedChannelId !== leftChannelId) {
    const channel = newState.channel;

    /* Start a new session if this channel has none */
    let session = activeSessions.get(joinedChannelId);
    if (!session) {
      const { v4: uuidv4 } = await import("uuid");
      session = {
        sessionId: uuidv4(),
        guildId: guild.id,
        guildName: guild.name,
        channelId: joinedChannelId,
        channelName: channel?.name || joinedChannelId,
        startTime: new Date(),
        participants: new Map(),
        textLog: [],
      };
      activeSessions.set(joinedChannelId, session);
      startVoiceSession(session).catch(err =>
        console.error("[VoiceTracking] Start session error:", err.message)
      );
    }

    /* Resolve Athena user ID (null if they've never messaged Athena) */
    const athenaUserId = await getAthenaUserIdForDiscordId(user.id).catch(() => null);

    /* Add participant to in-memory session */
    session.participants.set(user.id, {
      joinTime: Date.now(),
      athenaUserId,
      discordId: user.id,
      displayName: user.globalName || user.username,
      textMessages: [],
    });

    /* Record join in Firebase */
    recordParticipantJoin(session.sessionId, {
      athenaUserId,
      discordId: user.id,
      displayName: user.globalName || user.username,
      joinTime: Date.now(),
    }).catch(err =>
      console.warn(`[Voice] recordParticipantJoin failed for ${user.username} → ${session.sessionId}: ${err.message}`)
    );

    /* Ensure voice recognition profile exists for this user */
    if (athenaUserId) {
      getOrCreateVoiceProfile(athenaUserId, user).catch(err =>
        console.error("[VoiceTracking] Profile create error:", err.message)
      );
    }

    /* ── Auto-join for passive listening ──────────────────────────────────────
       If Athena isn't already in any voice channel in this guild she will
       silently join to listen and transcribe, without needing to be invited. */
    if (channel && !isInVoice(guild.id)) {
      joinChannel(guild, channel, { passive: true })
        .then(state => {
          console.log(`[AutoJoin] Passively joined #${channel.name} in ${guild.name}`);
          startListeningInChannel(state.connection, guild, client, session.sessionId);
        })
        .catch(err => {
          console.warn(`[AutoJoin] Could not join #${channel.name}: ${err.message}`);
        });
    }
  }
});

/* ---------------- READY ---------------- */
client.once(Events.ClientReady, async () => {
  console.log(`[Athena] Online as ${client.user.tag}`);

  /* store primary guild ID so DM history queries work */
  if (!primaryGuildId && client.guilds.cache.size > 0) {
    primaryGuildId = client.guilds.cache.first().id;
    console.log(`[Athena] Primary guild: ${client.guilds.cache.first().name} (${primaryGuildId})`);
  }

  /* 0. Firestore startup self-test — full write/read/delete probe per critical
        collection. Each probe writes a sentinel doc with id "__startup_probe__",
        reads it back, and deletes it. The sentinel docId is filterable so it
        won't pollute production queries (which all use where(...) filters on
        title/source/etc.). Every probe logs an explicit PASS or FAIL line so
        a glance at PM2 logs reveals whether each collection is healthy. */
  const PROBE_COLLECTIONS = [
    "messages",
    "athena_knowledge",
    "voice_fingerprints",
    "voice_sessions",
    "member_visual_profiles",
    "discord_quiz_results",
  ];
  /* Unique per-instance probe id so concurrent bot instances don't collide. */
  const PROBE_DOC_ID = `__startup_probe__${process.pid}_${Date.now()}`;
  const probeStarted = Date.now();
  for (const col of PROBE_COLLECTIONS) {
    const ref = firestore.collection(col).doc(PROBE_DOC_ID);
    try {
      await ref.set({
        _probe:    true,
        bootedAt:  admin.firestore.FieldValue.serverTimestamp(),
        pid:       process.pid,
        host:      process.env.HOSTNAME || "unknown",
      });
      const snap = await ref.get();
      if (!snap.exists) {
        console.error(`[Firestore:${col}] Self-test FAIL — write succeeded but read returned empty.`);
        continue;
      }
      console.log(`[Firestore:${col}] Self-test PASS (write+read+delete)`);
    } catch (err) {
      console.error(`[Firestore:${col}] Self-test FAIL —`, err.message);
    } finally {
      /* Best-effort cleanup so sentinel docs never linger in production
         collections, even if read or set partially failed. */
      try { await ref.delete(); } catch {}
    }
  }
  console.log(`[Firestore] Startup probes completed in ${Date.now() - probeStarted}ms`);

  /* Supplemental single-doc round-trip on a dedicated diagnostics path.
     This proves Firestore connectivity end-to-end on a non-production
     collection so any orphan docs are isolated from real data. */
  {
    const diagRef = firestore.collection("_diagnostics").doc(`startup_${process.pid}_${Date.now()}`);
    try {
      await diagRef.set({
        at:    admin.firestore.FieldValue.serverTimestamp(),
        pid:   process.pid,
        host:  process.env.HOSTNAME || "unknown",
        probeId: PROBE_DOC_ID,
      });
      const diagSnap = await diagRef.get();
      if (diagSnap.exists) {
        console.log(`[Firestore:_diagnostics/startup] Round-trip PASS (write+read+delete)`);
      } else {
        console.error(`[Firestore:_diagnostics/startup] Round-trip FAIL — wrote but read empty.`);
      }
    } catch (err) {
      console.error(`[Firestore:_diagnostics/startup] Round-trip FAIL —`, err.message);
    } finally {
      try { await diagRef.delete(); } catch {}
    }
  }

  /* Probe the actual nested voice-session path used at runtime
     (athena_ai/voice_sessions/sessions). The top-level voice_sessions probe
     above only validates root-collection access; this probe validates the
     real write path used by voiceRecognition.js. */
  {
    const nestedRef = firestore
      .collection("athena_ai").doc("voice_sessions")
      .collection("sessions").doc(PROBE_DOC_ID);
    try {
      await nestedRef.set({
        _probe:   true,
        bootedAt: admin.firestore.FieldValue.serverTimestamp(),
        pid:      process.pid,
      });
      const nestedSnap = await nestedRef.get();
      if (nestedSnap.exists) {
        console.log(`[Firestore:athena_ai/voice_sessions/sessions] Self-test PASS (write+read+delete)`);
      } else {
        console.error(`[Firestore:athena_ai/voice_sessions/sessions] Self-test FAIL — write succeeded but read returned empty.`);
      }
    } catch (err) {
      console.error(`[Firestore:athena_ai/voice_sessions/sessions] Self-test FAIL —`, err.message);
    } finally {
      try { await nestedRef.delete(); } catch {}
    }
  }

  /* 1. Sync ALL guild members → full contact cards (bots excluded) */
  for (const [, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      const all = [...members.values()].filter(m => !m.user.bot);
      console.log(`[Athena] Syncing ${all.length} members from ${guild.name}...`);

      /* process in batches of 10 to avoid flooding Firestore */
      let synced = 0;
      for (let i = 0; i < all.length; i += 10) {
        const batch = all.slice(i, i + 10);
        await Promise.allSettled(batch.map(m => syncMemberToFirebase(m)));
        synced += batch.length;
      }
      console.log(`[Athena] Synced ${synced} / ${all.length} members from ${guild.name}`);
    } catch (error) {
      console.error(`[Athena] Sync error:`, error.message);
    }
  }

  /* 2. Load knowledge base */
  const knowledge = await getKnowledgeBase();
  console.log(`[Athena] Loaded ${knowledge.length} knowledge entries`);

  /* 3. Start autonomous knowledge learning (every 60 seconds) */
  startKnowledgeLearning();

  /* 4. Build communication style profiles from historical messages (non-blocking) */
  setTimeout(() => {
    buildAllStyleProfiles()
      .then(r => console.log(`[VoiceRecognition] Startup profile build: ${r.built}/${r.total} profiles built`))
      .catch(err => console.error("[VoiceRecognition] Startup profile build error:", err.message));
  }, 15000); /* wait 15s after ready to let Firestore settle */

  /* 5. Backfill all channel history (non-blocking — runs in background) */
  for (const [, guild] of client.guilds.cache) {
    backfillDiscordHistory(guild, { limitPerChannel: 1000 })
      .then(({ totalStored }) => console.log(`[Backfill] ${guild.name}: ${totalStored} historical messages stored`))
      .catch(err => console.error(`[Backfill] Error for ${guild.name}:`, err.message));
  }

  /* 5.5. DOJ press release sync (non-blocking — runs in background after 30s) */
  setTimeout(() => {
    syncLatestDojPressReleases(25)
      .then(count => console.log(`[DOJ] Startup sync complete — ${count} new entries stored`))
      .catch(err => console.error("[DOJ] Startup sync failed:", err.message));
  }, 30000);

  /* Daily DOJ re-sync — runs every 24 hours */
  setInterval(() => {
    syncLatestDojPressReleases(25)
      .then(count => console.log(`[DOJ] Daily sync — ${count} new entries stored`))
      .catch(err => console.error("[DOJ] Daily sync failed:", err.message));
  }, 24 * 60 * 60 * 1000);

  /* 5.7. Regional knowledge sweep — pulls one news article per U.S. state and
          per continent every 24 hours so Athena always has fresh per-region
          coverage. Initial run after 60s so it doesn't pile on top of DOJ
          startup sync; recurring run every 24h. */
  const { runDailySweep, REGIONS } = await import("./lib/regionalFetcher.js");
  const { runProfileSweep }        = await import("./lib/regionalProfile.js");
  const { storeNewKnowledge }      = await import("./lib/knowledgeUpdater.js");
  const regionalStoreFn = entry =>
    storeNewKnowledge({
      title:       entry.title,
      body:        entry.content,
      source:      entry.source,
      verified:    entry.verified,
      explanation: `Regional update for ${entry.region} (${entry.category})`,
    });

  setTimeout(() => {
    runDailySweep(regionalStoreFn).catch(err =>
      console.error("[RegionalSweep] Startup sweep failed:", err.message)
    );
  }, 60_000);

  setInterval(() => {
    runDailySweep(regionalStoreFn).catch(err =>
      console.error("[RegionalSweep] Daily sweep failed:", err.message)
    );
  }, 24 * 60 * 60 * 1000);

  /* 5.8. Regional ORIGIN/HISTORY profile sweep — pulls Encyclopaedia
          Britannica summaries (accredited reference source) for History,
          Geography, Economy, and People of every U.S. state and continent.
          Runs ~3 minutes after startup so it doesn't collide with the news
          sweep, and weekly thereafter — storeNewKnowledge dedupes by
          title so re-runs are cheap. Wikipedia is excluded by policy. */
  setTimeout(() => {
    runProfileSweep(REGIONS, regionalStoreFn).catch(err =>
      console.error("[RegionalProfile] Startup sweep failed:", err.message)
    );
  }, 3 * 60_000);

  setInterval(() => {
    runProfileSweep(REGIONS, regionalStoreFn).catch(err =>
      console.error("[RegionalProfile] Weekly sweep failed:", err.message)
    );
  }, 7 * 24 * 60 * 60 * 1000);

  /* 5.6. Weekly quiz reminders — DM every member who hasn't completed the quiz */
  const primaryGuild = primaryGuildId ? client.guilds.cache.get(primaryGuildId) : client.guilds.cache.first();
  if (primaryGuild) {
    scheduleWeeklyReminders(primaryGuild);
  }

  /* !quiz remind — admin command to trigger manually (checked in message handler) */

  /* 6. Resume tracking for anyone already in voice channels when bot starts.
        This handles the case where the bot restarts while a call is ongoing — the
        VoiceStateUpdate events that fired before the bot was online are missed, so we
        manually create sessions for any occupied voice channels. */
  const { v4: uuidv4 } = await import("uuid");
  for (const [, guild] of client.guilds.cache) {
    for (const [, channel] of guild.channels.cache) {
      if (channel.type !== ChannelType.GuildVoice) continue;
      const humanMembers = [...channel.members.values()].filter(m => !m.user.bot);
      if (humanMembers.length === 0) continue;
      if (activeSessions.has(channel.id)) continue; /* already tracked */

      const session = {
        sessionId: uuidv4(),
        guildId: guild.id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: channel.name,
        startTime: new Date(),
        participants: new Map(),
        textLog: [],
      };
      activeSessions.set(channel.id, session);

      startVoiceSession(session).catch(err =>
        console.error("[VoiceBackfill] Start session error:", err.message)
      );

      for (const member of humanMembers) {
        const athenaUserId = await getAthenaUserIdForDiscordId(member.user.id).catch(() => null);
        session.participants.set(member.user.id, {
          joinTime: Date.now(),
          athenaUserId,
          discordId: member.user.id,
          displayName: member.user.globalName || member.user.username,
          textMessages: [],
        });
        recordParticipantJoin(session.sessionId, {
          athenaUserId,
          discordId: member.user.id,
          displayName: member.user.globalName || member.user.username,
          joinTime: Date.now(),
        }).catch(err =>
          console.warn(`[VoiceBackfill] recordParticipantJoin failed for ${member.user.username} → ${session.sessionId}: ${err.message}`)
        );
      }
      console.log(`[VoiceBackfill] Resumed session for #${channel.name} — ${humanMembers.length} humans already present`);

      /* Auto-join the occupied channel so Athena can listen from the start */
      if (!isInVoice(guild.id)) {
        joinChannel(guild, channel, { passive: true })
          .then(state => {
            console.log(`[VoiceBackfill] Passively joined #${channel.name} in ${guild.name}`);
            startListeningInChannel(state.connection, guild, client, session.sessionId);
          })
          .catch(err => {
            console.warn(`[VoiceBackfill] Could not join #${channel.name}: ${err.message}`);
          });
      }
    }
  }

  /* 7. ── Voice guardian ─────────────────────────────────────────────────────
        Every 30 seconds, walk every active session and verify Athena still has
        a live voice connection in that channel. If she dropped (network blip,
        gateway closed the connection) and humans are still present, silently
        re-establish a fresh passive connection. Skips channels Athena was
        kicked from (4014 → 5min cooldown) and avoids stacking concurrent join
        attempts via an in-flight set. */
  const guardianInFlight  = new Set(); /* channelIds with a pending join */
  const guardianBackoff   = new Map(); /* channelId → nextAttemptMs after failure */
  const guardianLastDelay = new Map(); /* channelId → last delay (ms) used, for exponential growth */
  const guardianCrossChannelWarned = new Set(); /* channelIds we've already warned about being held by a different-channel passive conn (avoids log spam) */

  setInterval(async () => {
    for (const [, guild] of client.guilds.cache) {
      for (const [channelId, session] of activeSessions) {
        if (session.guildId !== guild.id) continue;
        if (guardianInFlight.has(channelId)) continue;
        if (isChannelEvicted(channelId)) continue;

        const backoffUntil = guardianBackoff.get(channelId) ?? 0;
        if (Date.now() < backoffUntil) continue;

        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildVoice) continue;

        const humansPresent = [...channel.members.values()].filter(m => !m.user.bot).length;
        if (humansPresent === 0) continue;

        const connectedHere =
          isInVoice(guild.id) && getVoiceChannelId(guild.id) === channelId;
        if (connectedHere) {
          guardianBackoff.delete(channelId);
          continue;
        }

        console.log(
          `[VoiceGuardian] Athena missing from #${channel.name} (${humansPresent} humans present) — re-establishing.`
        );
        guardianInFlight.add(channelId);
        joinChannel(guild, channel, { passive: true })
          .then(state => {
            /* joinChannel() may return an existing passive connection in a
               *different* channel within the same guild. In that case do NOT
               attach a listener to the wrong connection — that would stack
               duplicate receivers. Verify channel match first. */
            if (state.channelId !== channelId) {
              /* Single-voice-per-guild limitation: an existing passive
                 connection is in a different channel. Warn once per channel
                 to keep logs high-signal, then back off for 5 minutes. */
              if (!guardianCrossChannelWarned.has(channelId)) {
                console.warn(
                  `[VoiceGuardian] Cannot rejoin #${channel.name}: existing passive connection in different channel (${state.channelId}); single-voice-per-guild. Suppressing further warnings for this channel.`
                );
                guardianCrossChannelWarned.add(channelId);
              }
              guardianBackoff.set(channelId, Date.now() + 5 * 60_000);
              guardianLastDelay.set(channelId, 5 * 60_000);
              return;
            }
            startListeningInChannel(state.connection, guild, client, session.sessionId);
            guardianBackoff.delete(channelId);
            guardianLastDelay.delete(channelId);
            guardianCrossChannelWarned.delete(channelId);
            console.log(`[VoiceGuardian] Re-established passive listen in #${channel.name}`);
          })
          .catch(err => {
            /* Exponential backoff on duration (not absolute timestamps):
               start at 60s, double each failure, cap at 10min. */
            const prevDelay = guardianLastDelay.get(channelId) ?? 0;
            const nextDelay = prevDelay
              ? Math.min(10 * 60_000, prevDelay * 2)
              : 60_000;
            guardianLastDelay.set(channelId, nextDelay);
            guardianBackoff.set(channelId, Date.now() + nextDelay);
            console.warn(`[VoiceGuardian] Failed to re-join #${channel.name}: ${err.message} — backing off ${Math.round(nextDelay/1000)}s`);
          })
          .finally(() => {
            guardianInFlight.delete(channelId);
          });
      }
    }
  }, 30_000);
});

/* ---------------- LOGIN ---------------- */
client.login(process.env.DISCORD_TOKEN);
