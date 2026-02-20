"""
Wingman - FA Real-Time Assistant
Real-time financial advisory intelligence platform.

Backend server that:
1. Receives dual audio streams (mic + system speaker) from the browser via WebSocket
2. Routes each to a separate OpenAI Realtime Transcription connection for speaker-labeled transcription
3. Generates AI suggestions via GPT-5.2 when conversation context changes
4. Extracts client intelligence (personal details, sentiment, risk profile) in real-time
5. Monitors compliance in real-time, flagging potential issues
6. Generates post-call summaries, follow-up emails, and action items
"""

import asyncio
import base64
import json
import logging
import os
import time
from pathlib import Path

import websockets
from websockets.protocol import State as WsState
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from openai import AsyncOpenAI

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mads")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# Suggestion engine
SUGGESTION_COOLDOWN_SECONDS = 3
MIN_NEW_CHARS_FOR_SUGGESTION = 30

# Intelligence engine
INTELLIGENCE_COOLDOWN_SECONDS = 8
MIN_NEW_CHARS_FOR_INTELLIGENCE = 50

# Compliance engine
COMPLIANCE_COOLDOWN_SECONDS = 5
MIN_NEW_CHARS_FOR_COMPLIANCE = 40

# Todo engine
TODO_COOLDOWN_SECONDS = 6
MIN_NEW_CHARS_FOR_TODO = 40

# Word cloud engine
WORDCLOUD_COOLDOWN_SECONDS = 5
MIN_NEW_CHARS_FOR_WORDCLOUD = 40

# Models
OPENAI_MODEL = "gpt-5.2"
TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"

# Audio source IDs (first byte of each binary audio packet from browser)
SOURCE_MIC = 0x01       # Advisor's microphone
SOURCE_SPEAKER = 0x02   # System speaker (client's voice from Zoom)

SPEAKER_LABELS = {
    SOURCE_MIC: "Advisor",
    SOURCE_SPEAKER: "Client",
}

# ---------------------------------------------------------------------------
# Morgan Stanley Knowledge Base (injected into all AI engine prompts)
# ---------------------------------------------------------------------------

MS_KNOWLEDGE_BASE = """
=== MORGAN STANLEY WEALTH MANAGEMENT CONTEXT ===

You are operating within Morgan Stanley Wealth Management (MSWM). All suggestions, analysis, and language
must reflect Morgan Stanley's actual products, platforms, advisory programs, and terminology.

TERMINOLOGY:
- Always say "Financial Advisor" (FA), never "advisor" or "financial planner"
- Always say "client household" not "customer" or "account holder"
- Always say "client review" not "meeting" when referring to scheduled discussions
- Use "portfolio construction" not "asset allocation" when discussing managed accounts
- Use "investment policy" not "investment plan"

MS ADVISORY PROGRAMS & PRODUCTS:
- Select UMA (Unified Managed Account): Consolidates SMAs, mutual funds, and ETFs in one account.
  Tailored asset allocation with disciplined manager selection and ongoing professional oversight.
  Ideal for clients who want institutional-grade portfolio construction with tax efficiency.
- Total Tax 365: Year-round active tax management. Includes tax-loss harvesting, wash sale adherence,
  client-directed gain/tax limits, and "best tax outcome" trade methodology. Can add up to 2% annually.
- Goals Planning System (GPS): Morgan Stanley's proprietary goals-based financial planning platform.
  Four stages: Discover, Advise, Implement, Track Progress. Links all financial info to client priorities.
- CashPlus: Premium brokerage account combining investing, banking, and lending in one place.
- Consulting Group Advisor (CGA): Professional portfolio management through MS's Consulting Group.
- Separately Managed Accounts (SMAs): Direct ownership of individual securities with professional management.
- Morgan Stanley Active Assets Account: Full-service brokerage with integrated cash management.
- Parametric Direct Indexing: Tax-efficient custom index replication (MS subsidiary Parametric).
  Excellent for high-net-worth clients seeking tax-loss harvesting with customization.
- Impact Investing Platform: ESG and sustainable investing solutions across asset classes.
- Alternative Investments: Private Equity, Private Credit, Real Assets, Hedge Funds, Digital Assets.
  Require accredited investor status. Important for portfolio diversification for HNW+ clients.
- Morgan Stanley Lending: Securities-Based Lending (SBL), Tailored Lending, mortgage solutions.
  Liquidity without selling appreciated positions.
- Variable Annuities & Insured Solutions: Guaranteed income products for retirement planning.
- 529 Education Savings Plans: Tax-advantaged education funding vehicles.
- Municipal Bond Solutions: Tax-exempt income strategies for high-tax-bracket clients.

MS TECHNOLOGY & PLATFORMS (reference these when relevant):
- WealthDesk: Unified FA platform integrating planning, advice, portfolio construction, and implementation.
  Includes Variance Dashboard for monitoring all client accounts for drift.
- Goals Planning System (GPS): Integrated into WealthDesk for holistic financial planning.
- Portfolio Risk Platform (powered by BlackRock Aladdin): Institutional-caliber risk analytics
  available to every FA. Stress testing, scenario analysis, factor exposure.
- Next Best Action (NBA): AI engine that suggests personalized actions based on client data.
  Over 90% FA adoption. Drives 30% higher client engagement.
- AI @ Morgan Stanley Assistant: GPT-powered research tool with access to 350,000+ MS documents.
- AI @ Morgan Stanley Debrief: Meeting intelligence tool for auto-generated notes and follow-ups.

MS CLIENT SEGMENTS (reference the appropriate tier):
- Ultra High Net Worth (UHNW): $10M+ investable assets. Access to Private Wealth Management,
  alternative investments, custom lending, family office services, estate planning specialists.
- High Net Worth (HNW): $1M-$10M investable assets. Full advisory services, Select UMA,
  GPS planning, alternative investment access.
- Affluent: $250K-$1M investable assets. Managed account programs, GPS planning, CashPlus.
- Mass Affluent: Under $250K. Standard brokerage, CashPlus, digital advisory options.

MS COMPLIANCE FRAMEWORK:
- Reg BI (Regulation Best Interest): Every recommendation must be in the client's best interest.
  Cannot prioritize firm or FA compensation over client outcomes.
- Form CRS (Client Relationship Summary): Must be delivered at start of relationship.
  Discloses services, fees, conflicts, and disciplinary history.
- Care Obligation: Must have reasonable basis for every recommendation. Must consider reasonably
  available alternatives. Cannot recommend complex products without understanding features/risks.
- Conflict of Interest: Must identify and mitigate conflicts. Revenue sharing, proprietary products,
  and compensation incentives must be disclosed and managed.
- Suitability: Complex products (alternatives, variable annuities, structured products) require
  enhanced suitability review. Product switches require cost-benefit analysis.
- Concentration Limits: Must monitor and flag excessive concentration in single securities or sectors.

MS-SPECIFIC STRATEGIES:
- Tax-Loss Harvesting via Total Tax 365 (not generic TLH)
- Goals-Based Wealth Management through GPS (not generic financial planning)
- Direct Indexing via Parametric for tax alpha
- Securities-Based Lending for liquidity events (avoid selling appreciated positions)
- Charitable Remainder Trust / Donor-Advised Fund for philanthropic clients
- Roth Conversion Ladder strategy for early retirees
- Bucket Strategy for retirement income (short-term, medium-term, growth)
- UMA Consolidation to reduce fee drag and improve tax coordination
- Asset Location optimization across taxable, tax-deferred, and tax-free accounts

=== END MORGAN STANLEY CONTEXT ===
"""

# ---------------------------------------------------------------------------
# System Prompts
# ---------------------------------------------------------------------------

SUGGESTION_SYSTEM_PROMPT = f"""You are an AI co-pilot for a Morgan Stanley Financial Advisor (FA) on a LIVE client call.

{MS_KNOWLEDGE_BASE}

The transcript uses "Advisor:" and "Client:" labels.

Your job: generate ONE ultra-short, highly specific suggestion (MAX 10 words) the FA can act on RIGHT NOW.

React to the CLIENT's most recent statements. Help the FA:
- Recommend MORGAN STANLEY products BY NAME (Select UMA, Total Tax 365, GPS, Parametric Direct Indexing, CashPlus, SMAs, Alternative Investments, Securities-Based Lending, etc.)
- Suggest MS-specific strategies (UMA consolidation, Total Tax 365 harvesting, GPS goal tracking, Parametric customization, asset location optimization, etc.)
- Reference MS platforms when relevant (run Aladdin stress test, check Variance Dashboard, review NBA insights, update GPS plan)
- Ask smart probing questions to uncover deeper needs, referral opportunities, or planning gaps
- Spot cross-sell or planning opportunities using the MS product suite

Format: **ActionVerb** specific actionable detail

GOOD examples (MS-specific — names MS products, strategies, or exact actions):
- **Suggest** Select UMA for consolidated tax-efficient management
- **Recommend** Total Tax 365 harvesting on taxable positions
- **Ask** about GPS goal progress for retirement timeline
- **Mention** Parametric Direct Indexing for tax alpha
- **Consider** Securities-Based Lending vs selling appreciated stock
- **Recommend** Aladdin stress test on current equity concentration
- **Suggest** 529 Plan within GPS education goal framework
- **Mention** Alternative Investments for portfolio diversification
- **Ask** if spouse needs separate GPS financial plan

BAD examples (too generic — NEVER produce these):
- Suggest creating a budget plan (no MS product named)
- Recommend reviewing expenses (any advisor could say this)
- Consider diversifying the portfolio (vague, no MS solution)

RULES:
1. MAXIMUM 10 words. The FA reads this mid-conversation.
2. Start with: **Suggest**, **Ask**, **Mention**, **Consider**, or **Recommend**.
3. Be SPECIFIC — always name an MS product, MS strategy, or exact question to ask.
4. React to what the CLIENT just said — don't give generic advice.
5. Prefer Morgan Stanley products and terminology over generic financial terms.
6. If the last few exchanges are purely greetings with zero financial or personal signals, respond exactly: NO_SUGGESTION
7. Do NOT repeat prior suggestions (listed below for context).
"""

COACHING_SUGGESTION_PROMPT = f"""You are an AI coaching co-pilot for a Morgan Stanley Financial Advisor (FA) on a LIVE client call.

{MS_KNOWLEDGE_BASE}

The transcript uses "Advisor:" and "Client:" labels.

Generate ONE suggestion with a brief coaching explanation. The FA is learning, so explain WHY using MS-specific context.

Format:
**ActionVerb** specific actionable detail
💡 Brief explanation of why this matters and what to say

Examples:
**Suggest** Select UMA to consolidate their managed accounts
💡 Client has multiple SMAs creating tax inefficiency. Select UMA consolidates into one account with coordinated tax management via Total Tax 365, reducing fee drag and improving after-tax returns.

**Recommend** Parametric Direct Indexing for taxable portfolio
💡 Client mentioned large taxable account with concentrated gains. Parametric (MS subsidiary) builds custom index portfolios that generate tax alpha through systematic loss harvesting while maintaining market exposure.

**Ask** about updating GPS plan for new retirement date
💡 Client just mentioned considering early retirement. Their Goals Planning System should be updated to model the shorter accumulation phase and longer distribution period. This is a great opportunity to demonstrate GPS's scenario analysis.

RULES:
1. Suggestion line: MAX 10 words. Start with **Suggest**, **Ask**, **Mention**, **Consider**, or **Recommend**.
2. Coaching line: 1-2 sentences explaining why using MS products/platforms. Start with 💡.
3. Be SPECIFIC — name MS products, MS strategies, or exact questions.
4. React to what the CLIENT just said.
5. Prefer Morgan Stanley products and terminology over generic financial terms.
6. If purely greetings with zero signals, respond exactly: NO_SUGGESTION
7. Do NOT repeat prior suggestions.
"""

INTELLIGENCE_SYSTEM_PROMPT = f"""You are a client relationship intelligence system for a Morgan Stanley Financial Advisor on a live call.

{MS_KNOWLEDGE_BASE}

Analyze the conversation transcript (labeled "Advisor:" and "Client:"). Extract ONLY high-value relationship intelligence — facts an FA would want to remember MONTHS from now for CRM entry and future client reviews.

Return a JSON object:
{{
  "family": ["People in the client's life: name + relationship ONLY. E.g. 'Son starting college soon', 'Wife: Sarah'. MAX 4 items."],
  "life_events": ["MAJOR milestones or upcoming events ONLY. E.g. 'Planning Europe vacation Jun/Jul next year', 'Son graduating high school'. NOT routine activities. MAX 3 items."],
  "interests": ["Hobbies, passions, or personal aspirations. E.g. 'Wants to travel to Italy, France, Switzerland'. MAX 3 items."],
  "career": ["Job title, employer, career stage. E.g. 'VP at tech company, considering early retirement'. MAX 2 items."],
  "key_concerns": ["Specific financial worries. E.g. 'Equity concentration risk in AAPL', 'College tuition costs in 3 years'. MAX 3 items."],
  "referral_opportunities": ["Family/friends who may need MS wealth management services. E.g. 'Wife may need separate GPS financial plan', 'Brother starting business — may need lending solutions'. MAX 2 items."],
  "ms_product_signals": ["Products/services the client may benefit from based on conversation signals. E.g. 'Candidate for Select UMA — has multiple uncoordinated accounts', 'Total Tax 365 — large taxable portfolio with gains', 'GPS update needed — new retirement timeline'. MAX 3 items."],
  "client_tier": "One of: UHNW ($10M+), HNW ($1M-$10M), Affluent ($250K-$1M), Mass Affluent (under $250K), Unknown",
  "sentiment": "One of: confident, enthusiastic, neutral, cautious, anxious, frustrated",
  "sentiment_detail": "One sentence explaining the client's emotional state",
  "risk_profile": "One of: very_conservative, conservative, moderate_conservative, moderate, moderate_aggressive, aggressive",
  "risk_detail": "One sentence explaining risk tolerance signals",
  "document_triggers": ["MS-specific forms or actions needed. E.g. 'Update GPS plan with new retirement date', 'Run Aladdin stress test on concentrated position', 'Review Form CRS delivery status'. MAX 3 items."]
}}

CRITICAL RULES — READ CAREFULLY:
1. Be EXTREMELY selective. Only extract facts worth remembering 6 months from now.
2. DO NOT paraphrase the conversation. Extract FACTS, not summaries.
3. Each item must be ≤12 words. Be concise.
4. SKIP mundane details: "work is busy", "things calming down", "haven't decided yet" — these have ZERO relationship value.
5. SKIP vague statements. Only include SPECIFIC details (names, places, dates, amounts, products).
6. family: Include ONLY named people or specific relationships. Not "has a family."
7. life_events: Include ONLY concrete upcoming/recent events with specifics. Not "thinking about plans."
8. interests: Include ONLY clearly expressed passions/hobbies. Not "mentioned a topic."
9. ms_product_signals: Only include if there are CLEAR signals from the conversation. Do NOT force-fit products.
10. client_tier: Estimate ONLY if dollar amounts or asset levels are discussed. Otherwise "Unknown".
11. If a category has nothing worth noting, return an EMPTY array []. Do NOT pad with filler.
12. sentiment and risk_profile: Based on CLIENT's tone, not the FA's.
13. Return ONLY valid JSON.
"""

COMPLIANCE_SYSTEM_PROMPT = f"""You are a Morgan Stanley compliance monitor reviewing a LIVE FA-client conversation under Reg BI and Morgan Stanley's internal compliance framework.

{MS_KNOWLEDGE_BASE}

Scan ONLY the ADVISOR's statements (labeled "Advisor:") for potential compliance issues under Morgan Stanley's regulatory obligations:

1. REG BI — CARE OBLIGATION VIOLATIONS:
   - Recommending products without reasonable basis to believe they are in client's best interest
   - Failing to consider reasonably available alternatives (e.g., recommending high-fee product when lower-cost MS option exists)
   - Recommending complex products (alternatives, structured products, variable annuities) without demonstrating understanding of features/risks
   - Product switches (e.g., variable annuity exchanges) without cost-benefit analysis

2. REG BI — CONFLICT OF INTEREST:
   - Failing to disclose material conflicts (proprietary products, revenue sharing, compensation incentives)
   - Recommending proprietary MS products without mentioning alternatives

3. GUARANTEE / MISLEADING LANGUAGE:
   - "guaranteed", "promise", "definitely will", "can't lose", "sure thing", "no risk", "always goes up"
   - Promising specific returns or guaranteed outcomes
   - Cherry-picked performance data or unsubstantiated predictions

4. SUITABILITY ISSUES:
   - Product mismatch to client's expressed risk tolerance, timeline, or needs
   - Concentration risk — failing to address or flag excessive single-stock exposure
   - Recommending illiquid alternatives to clients who may need liquidity

5. MISSING DISCLOSURES:
   - Alternative investments discussed without accredited investor verification
   - Advisory fee structure not disclosed when transitioning from brokerage to advisory relationship
   - Variable annuity features (surrender charges, M&E fees) not explained

6. PRESSURE TACTICS:
   - Creating false urgency or pressuring quick decisions
   - Discouraging client from seeking second opinions or taking time to decide

7. FORM CRS:
   - If this appears to be a new client relationship, flag if no mention of Form CRS delivery

Return a JSON object:
{{
  "flags": [
    {{
      "severity": "warning or critical",
      "issue": "Brief description referencing the specific Reg BI or MS compliance rule violated",
      "recommendation": "What the FA should say or do instead, referencing MS-compliant language"
    }}
  ]
}}

If NO compliance issues are found, return: {{"flags": []}}

RULES:
1. Only flag REAL issues — don't flag normal advisory conversation.
2. "warning" = should be aware; "critical" = must address immediately (Reg BI violation, guarantee language).
3. Be specific about what was said and which compliance rule it relates to.
4. Reference MS-specific compliance standards, not generic ones.
5. Return ONLY valid JSON.
"""

TODO_SYSTEM_PROMPT = f"""You are extracting real-time action items from a LIVE Morgan Stanley FA–client conversation.

{MS_KNOWLEDGE_BASE}

Scan the transcript (labeled "Advisor:" and "Client:") and identify tasks the FA must follow up on — things to send, research, schedule, prepare, or confirm using Morgan Stanley systems and products.

Return a JSON object:
{{
  "items": ["Short to-do pointer (5-7 words max)", ...]
}}

RULES:
1. Each item MUST be 5-7 words. Not a full sentence.
2. Start with an action verb: Send, Schedule, Research, Prepare, Review, Follow up, Confirm, Update, Run, etc.
3. Be specific — reference MS products, platforms, or specific topics discussed.
4. Only include items that emerged from the conversation — don't invent tasks.
5. If no new action items exist, return: {{"items": []}}
6. Do NOT repeat previously extracted items (listed below).
7. Return ONLY valid JSON.

GOOD examples (MS-specific):
- Update GPS plan with new timeline
- Run Aladdin stress test on portfolio
- Send Select UMA proposal to client
- Schedule GPS review for next quarter
- Research Parametric Direct Indexing options
- Prepare Total Tax 365 enrollment paperwork
- Review concentration in tech holdings
- Send 529 Plan comparison via WealthDesk
- Confirm accredited investor status for alternatives
- Update client profile in WealthDesk CRM

BAD examples (too long or vague):
- Send the client a comparison document about 529 Plans and other education savings options
- Follow up with client
- Do some research
"""

WORDCLOUD_SYSTEM_PROMPT = f"""You are analyzing a live Morgan Stanley FA-client conversation to generate a real-time word cloud visualization focused on the CLIENT's priorities.

{MS_KNOWLEDGE_BASE}

Analyze the full transcript and extract the CLIENT's top focus topics — the concepts, concerns, goals, and interests they emphasize most. Use Morgan Stanley terminology where applicable.

Return a JSON object:
{{
  "topics": [
    {{ "text": "topic phrase", "weight": 1-10, "tone": "positive|neutral|concerned|anxious" }}
  ]
}}

RULES:
1. Extract 10-25 topics depending on conversation length. Each topic is 1-3 words.
2. Focus ONLY on what the CLIENT cares about — their concerns, interests, goals, worries. Not the FA's words.
3. Weight reflects conversational emphasis (10 = dominant focus the client keeps returning to, 1 = briefly mentioned once).
4. Tone classification based on the client's emotional coloring of this topic:
   - "positive": client sounds excited, hopeful, looking forward to this
   - "neutral": mentioned factually, informational, no strong emotion
   - "concerned": worried, uncertain, wants reassurance about this
   - "anxious": stressed, fearful, urgent worry about this
5. SKIP generic filler words: "money", "account", "planning", "financial", "advisor", "meeting", "think", "know", "like", "want", "need", "really", "just".
6. USE MS-specific meaningful terms where the conversation references them: "Select UMA", "GPS goals", "Total Tax 365", "tax harvesting", "Parametric", "Aladdin risk", "alternatives".
7. Also use specific financial terms: "college fund", "retirement income", "market volatility", "tax strategy", "529 plan", "estate plan", "Roth conversion", "concentration risk".
8. Include personal/life topics too: "son's college", "Europe trip", "career change", "new house".
9. For short conversations (under 5 exchanges), return fewer topics (5-10). Don't pad with filler.
10. If the conversation is pure greetings with no substantive client topics, return: {{"topics": []}}
11. Return ONLY valid JSON.
"""

POST_CALL_SYSTEM_PROMPT = f"""You are generating a Morgan Stanley post-call intelligence report for a Financial Advisor.

{MS_KNOWLEDGE_BASE}

This report will be used for CRM entry, follow-up planning, and compliance documentation. Use Morgan Stanley terminology throughout.

Return a JSON object with these keys:
{{
  "summary": "Concise 3-5 sentence client review recap using MS terminology. Reference specific MS products discussed, planning outcomes, and client household decisions.",
  "follow_up_email": "Professional, warm email from the FA to the client. Must feel like it comes from a Morgan Stanley FA — reference MS products/services by name, mention specific discussion points, and outline concrete next steps. Use 'your Morgan Stanley team' language. Max 150 words.",
  "action_items": ["MS-specific actionable items. Reference MS systems/products. E.g. 'Update GPS plan with revised retirement date by Friday', 'Submit Select UMA proposal through WealthDesk', 'Run Aladdin portfolio stress test for equity concentration'"],
  "client_insights": ["Key insights worth remembering for future client reviews. Include any MS product opportunities identified."],
  "next_meeting_topics": ["Suggested agenda items for the next client review, referencing MS products and planning tools."],
  "compliance_notes": ["Any compliance-relevant observations. E.g. 'Client expressed interest in alternatives — verify accredited investor status before next review', 'Discussed fee transition from brokerage to advisory — ensure Form CRS delivered', 'No guarantee language used — clean'. If nothing notable, include 'No compliance concerns identified during this client review.'"],
  "crm_activity_log": {{
    "activity_type": "Client Review",
    "contact_method": "Video Call" or "Phone Call" (infer from context, default "Video Call"),
    "meeting_purpose": "Brief 5-8 word purpose. E.g. 'Quarterly Portfolio Review & GPS Update'",
    "attendees": "Infer from transcript, e.g. 'FA, Client, Spouse' — list roles mentioned",
    "accounts_discussed": ["List specific account types discussed, e.g. 'Joint Brokerage', 'Roth IRA', 'Revocable Trust'"],
    "products_discussed": ["List MS products/services mentioned. E.g. 'Select UMA', 'GPS Financial Planning', 'Total Tax 365', 'SBL'"],
    "risk_profile_confirmed": true or false (did the FA discuss or confirm risk tolerance?),
    "suitability_notes": "One sentence on suitability. E.g. 'Recommendations aligned with moderate-aggressive risk profile and 15-year horizon.'",
    "disclosure_notes": "Any disclosures made or needed. E.g. 'Form CRS referenced during advisory fee discussion.' If none, 'No new disclosures required.'",
    "client_sentiment": "positive" or "neutral" or "concerned" or "negative",
    "assets_in_motion": "Any money movement discussed — contributions, withdrawals, transfers, rollovers. If none, 'None discussed.'",
    "referral_opportunities": "Any referral or specialist needs identified. E.g. 'Referred to MS Tax Specialist for 10b5-1 plan review.' If none, 'None identified.'",
    "next_contact_date": "Suggested follow-up date in YYYY-MM-DD format, approximately 1-2 weeks from today. Use today's context.",
    "next_contact_type": "Follow-Up Call" or "Quarterly Review" or "Annual Review" or "Ad Hoc"
  }}
}}

RULES:
1. Keep every section concise — quality over quantity.
2. Use Morgan Stanley terminology: "client review" not "meeting", "Financial Advisor" not "advisor", "client household" not "customer".
3. The email should feel personal AND institutional — it should clearly be from a Morgan Stanley FA.
4. Action items must reference MS products/platforms where relevant ("Submit Select UMA proposal via WealthDesk", not just "Follow up").
5. Limit action_items to the top 5 most important.
6. Limit client_insights to the top 3-4 most valuable.
7. Limit next_meeting_topics to 3-4 items.
8. compliance_notes: Always include at least one entry. This supports Reg BI documentation requirements.
9. crm_activity_log: All fields are REQUIRED. This is used to auto-fill the CRM system. Be specific — pull real data from the conversation.
10. Return ONLY valid JSON.
"""

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Wingman - FA Real-Time Assistant")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "openai_configured": bool(OPENAI_API_KEY),
    }


@app.get("/prep")
async def prep_page():
    return FileResponse(str(STATIC_DIR / "prep.html"))


# ---------------------------------------------------------------------------
# Client Data API
# ---------------------------------------------------------------------------

CLIENT_DATA_PATH = STATIC_DIR / "data" / "clients.json"


def _load_clients() -> list[dict]:
    try:
        with open(CLIENT_DATA_PATH, "r") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load client data: {e}")
        return []


@app.get("/api/clients")
async def search_clients(q: str = ""):
    clients = _load_clients()
    if q:
        q_lower = q.lower()
        clients = [
            c for c in clients
            if q_lower in c["name"].lower()
            or q_lower in c["id"].lower()
            or q_lower in c.get("primary_contact", "").lower()
        ]
    return [
        {
            "id": c["id"],
            "name": c["name"],
            "primary_contact": c["primary_contact"],
            "client_tier": c["client_tier"],
            "total_aum": c["total_aum"],
            "next_review_due": c.get("next_review_due", ""),
        }
        for c in clients
    ]


@app.get("/api/clients/{client_id}")
async def get_client(client_id: str):
    clients = _load_clients()
    for c in clients:
        if c["id"] == client_id:
            return c
    return {"error": "Client not found"}


@app.post("/api/suggest-discussion-points")
async def suggest_discussion_points_api(request: Request):
    """Generate AI-suggested discussion points from client data (pre-call, no WebSocket needed)."""
    payload = await request.json()
    client_id = payload.get("client_id", "")

    # Build client context prompt from client data
    client_data = None
    context_prompt = ""
    if client_id:
        clients = _load_clients()
        client_data = next((c for c in clients if c["id"] == client_id), None)

    if client_data:
        name = client_data.get("name", "Unknown")
        tier = client_data.get("client_tier", "Unknown")
        aum = client_data.get("total_aum", 0)
        risk = client_data.get("risk_profile", "unknown")

        accounts_text = ""
        for acct in client_data.get("accounts", []):
            flags_text = f" FLAGS: {', '.join(acct['flags'])}" if acct.get("flags") else ""
            accounts_text += (
                f"  - {acct['name']} ({acct['type']}, {acct.get('program', 'N/A')}): "
                f"${acct['value']:,.0f} — {acct.get('holdings_summary', 'N/A')}"
                f"{' [Total Tax 365 enrolled]' if acct.get('total_tax_365') else ''}"
                f"{flags_text}\n"
            )

        goals_text = ""
        for goal in client_data.get("gps_goals", []):
            status = "ON TRACK" if goal.get("on_track") else "BEHIND"
            goals_text += (
                f"  - {goal['name']}: {goal['current_progress']}% toward "
                f"${goal.get('target', 0):,.0f} by {goal.get('timeline', '?')} [{status}]\n"
            )

        personal = client_data.get("personal", {})
        personal_text = ""
        if personal.get("family"):
            personal_text += f"  Family: {'; '.join(personal['family'])}\n"
        if personal.get("life_events"):
            personal_text += f"  Life Events: {'; '.join(personal['life_events'])}\n"

        past_conv_text = ""
        for conv in client_data.get("past_conversations", [])[:2]:
            past_conv_text += f"  [{conv['date']}] {conv['summary']}\n"
            if conv.get("action_items"):
                past_conv_text += f"    Action items: {', '.join(conv['action_items'])}\n"

        context_prompt = (
            f"Client: {name} | Tier: {tier} | AUM: ${aum:,.0f} | Risk: {risk}\n"
            f"Compliance: {client_data.get('compliance_notes', 'N/A')}\n\n"
            f"ACCOUNTS:\n{accounts_text}\n"
            f"GPS GOALS:\n{goals_text}\n"
            f"PERSONAL DETAILS:\n{personal_text}\n"
            f"RECENT CONVERSATIONS:\n{past_conv_text}"
        )

    user_prompt = ""
    if context_prompt:
        user_prompt = f"Client context:\n{context_prompt}\n\nSuggest 4-5 key discussion points for this call."
    else:
        user_prompt = "No client data available. Suggest standard quarterly review discussion points for a financial advisory call."

    try:
        client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        response = await client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": (
                    MS_KNOWLEDGE_BASE + "\n\n"
                    "You are a Morgan Stanley FA call preparation assistant.\n"
                    "Based on the client's portfolio, goals, past conversations, and any flags, "
                    "suggest 4-5 specific, actionable discussion points for this upcoming call.\n\n"
                    "Each point should be concise (8-15 words) and directly tied to the client's data.\n"
                    "Prioritize: outstanding action items from past calls, goals that are behind, "
                    "accounts with flags, upcoming reviews, and life events.\n\n"
                    "Return JSON: {\"points\": [\"point 1\", \"point 2\", ...]}\n"
                    "Return ONLY valid JSON."
                )},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=300,
            temperature=0.4,
            response_format={"type": "json_object"},
        )

        raw = response.choices[0].message.content or '{"points": []}'
        result = json.loads(raw)
        points = result.get("points", [])
        logger.info(f"Pre-call discussion suggestions: {len(points)} points for client {client_id or 'generic'}")
        return {"points": points}

    except Exception as e:
        logger.error(f"Discussion suggestion API error: {e}", exc_info=True)
        return {"points": [], "error": str(e)}


# ---------------------------------------------------------------------------
# AI Engines
# ---------------------------------------------------------------------------

class SuggestionEngine:
    """Generates ultra-short tactical suggestions for the FA."""

    def __init__(self):
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        self.prior_suggestions: list[str] = []

    async def generate(self, conversation_text: str, coaching_mode: bool = False) -> str | None:
        prior_context = ""
        if self.prior_suggestions:
            prior_context = "\n\nPrior suggestions already given (do NOT repeat these):\n"
            for i, s in enumerate(self.prior_suggestions, 1):
                prior_context += f"{i}. {s}\n"

        prompt = COACHING_SUGGESTION_PROMPT if coaching_mode else SUGGESTION_SYSTEM_PROMPT
        instruction = (
            "Generate ONE specific suggestion with coaching explanation."
            if coaching_mode
            else "Generate ONE specific suggestion (max 10 words). Name a product or strategy."
        )

        user_message = (
            f"Live conversation transcript:\n"
            f"---\n{conversation_text}\n---\n"
            f"{prior_context}\n"
            f"{instruction}"
        )

        try:
            response = await self.client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": user_message},
                ],
                max_completion_tokens=120 if coaching_mode else 40,
                temperature=0.7,
            )

            raw = response.choices[0].message.content or ""
            stripped = raw.strip()
            logger.info(f"SuggestionEngine raw response: '{stripped}'")

            if not stripped or "NO_SUGGESTION" in stripped.upper().replace(" ", "_"):
                logger.info("SuggestionEngine: no actionable suggestion — skipped")
                return None

            self.prior_suggestions.append(stripped)
            return stripped

        except Exception as e:
            logger.error(f"OpenAI suggestion error: {e}", exc_info=True)
            return None


class IntelligenceEngine:
    """Extracts client intelligence: personal details, sentiment, risk profile, referrals."""

    def __init__(self):
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)

    async def analyze(self, conversation_text: str) -> dict | None:
        try:
            response = await self.client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": INTELLIGENCE_SYSTEM_PROMPT},
                    {"role": "user", "content": (
                        f"Conversation transcript:\n---\n{conversation_text}\n---\n"
                        f"Extract client intelligence as JSON."
                    )},
                ],
                max_completion_tokens=800,
                temperature=0.3,
                response_format={"type": "json_object"},
            )

            raw = response.choices[0].message.content or "{}"
            logger.info(f"IntelligenceEngine response ({len(raw)} chars)")
            result = json.loads(raw)
            logger.info(
                f"  Parsed keys: {list(result.keys())}, "
                f"personal_notes count: {len(result.get('personal_notes', []))}"
            )
            return result

        except json.JSONDecodeError as e:
            logger.error(f"Intelligence JSON parse error: {e}")
            return None
        except Exception as e:
            logger.error(f"Intelligence engine error: {e}", exc_info=True)
            return None


class ComplianceEngine:
    """Scans advisor statements for potential compliance issues."""

    def __init__(self):
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        self.prior_flags: list[str] = []

    async def scan(self, conversation_text: str) -> list[dict]:
        prior_context = ""
        if self.prior_flags:
            prior_context = "\n\nAlready flagged issues (don't repeat):\n"
            for f in self.prior_flags:
                prior_context += f"- {f}\n"

        try:
            response = await self.client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": COMPLIANCE_SYSTEM_PROMPT},
                    {"role": "user", "content": (
                        f"Conversation transcript:\n---\n{conversation_text}\n---\n"
                        f"{prior_context}\nScan for NEW compliance issues. Return JSON."
                    )},
                ],
                max_completion_tokens=300,
                temperature=0.2,
                response_format={"type": "json_object"},
            )

            raw = response.choices[0].message.content or '{"flags": []}'
            result = json.loads(raw)
            flags = result.get("flags", [])

            for f in flags:
                self.prior_flags.append(f.get("issue", ""))

            if flags:
                logger.info(f"ComplianceEngine found {len(flags)} issue(s)")
            return flags

        except Exception as e:
            logger.error(f"Compliance engine error: {e}", exc_info=True)
            return []


class TodoEngine:
    """Extracts real-time action-item pointers (5-7 words each) during the call."""

    def __init__(self):
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        self.prior_items: list[str] = []

    async def extract(self, conversation_text: str) -> list[str]:
        prior_context = ""
        if self.prior_items:
            prior_context = "\n\nAlready extracted items (do NOT repeat):\n"
            for item in self.prior_items:
                prior_context += f"- {item}\n"

        try:
            response = await self.client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": TODO_SYSTEM_PROMPT},
                    {"role": "user", "content": (
                        f"Conversation transcript:\n---\n{conversation_text}\n---\n"
                        f"{prior_context}\nExtract NEW action-item to-do pointers as JSON."
                    )},
                ],
                max_completion_tokens=300,
                temperature=0.3,
                response_format={"type": "json_object"},
            )

            raw = response.choices[0].message.content or '{"items": []}'
            result = json.loads(raw)
            items = result.get("items", [])

            new_items = [i for i in items if i not in self.prior_items]
            self.prior_items.extend(new_items)

            if new_items:
                logger.info(f"TodoEngine extracted {len(new_items)} new item(s)")
            return new_items

        except Exception as e:
            logger.error(f"TodoEngine error: {e}", exc_info=True)
            return []


class WordCloudEngine:
    """Extracts weighted client focus topics for real-time word cloud visualization."""

    def __init__(self):
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)

    async def analyze(self, conversation_text: str) -> dict | None:
        try:
            response = await self.client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": WORDCLOUD_SYSTEM_PROMPT},
                    {"role": "user", "content": (
                        f"Conversation transcript:\n---\n{conversation_text}\n---\n"
                        f"Extract the client's focus topics for the word cloud as JSON."
                    )},
                ],
                max_completion_tokens=500,
                temperature=0.4,
                response_format={"type": "json_object"},
            )

            raw = response.choices[0].message.content or '{"topics": []}'
            logger.info(f"WordCloudEngine response ({len(raw)} chars)")
            result = json.loads(raw)
            topics = result.get("topics", [])
            if topics:
                logger.info(f"WordCloudEngine: {len(topics)} topics extracted")
            return result

        except json.JSONDecodeError as e:
            logger.error(f"WordCloud JSON parse error: {e}")
            return None
        except Exception as e:
            logger.error(f"WordCloud engine error: {e}", exc_info=True)
            return None


class PostCallEngine:
    """Generates post-call summary, follow-up email, and action items."""

    def __init__(self):
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)

    async def generate_summary(self, conversation_text: str) -> dict | None:
        try:
            response = await self.client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": POST_CALL_SYSTEM_PROMPT},
                    {"role": "user", "content": (
                        f"Transcript:\n---\n{conversation_text}\n---\n"
                        f"Generate the post-call JSON report. Be concise."
                    )},
                ],
                max_completion_tokens=2500,
                temperature=0.3,
                response_format={"type": "json_object"},
            )

            choice = response.choices[0]
            finish_reason = choice.finish_reason
            raw = choice.message.content or ""
            logger.info(
                f"PostCallEngine: finish_reason={finish_reason}, "
                f"content_length={len(raw)} chars"
            )

            if finish_reason == "length":
                logger.warning("PostCallEngine hit token limit — response may be truncated")

            if not raw or raw.strip() in ("", "{}"):
                logger.error("PostCallEngine returned empty content")
                return None

            return json.loads(raw)

        except json.JSONDecodeError as e:
            logger.error(f"PostCall JSON parse error: {e}")
            return None
        except Exception as e:
            logger.error(f"PostCall engine error: {e}", exc_info=True)
            return None


class DiscussionTrackerEngine:
    """Tracks which pre-defined discussion points have been covered during the call."""

    TRACKER_COOLDOWN_SECONDS = 5
    MIN_NEW_CHARS = 40

    def __init__(self):
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        self.discussion_points: list[dict] = []
        self.last_run_time: float = 0.0
        self.chars_at_last_run: int = 0
        self._running = False

    def set_points(self, points: list[str]):
        self.discussion_points = [
            {"text": p, "status": "pending"} for p in points
        ]

    async def evaluate(self, conversation_text: str) -> list[dict] | None:
        if not self.discussion_points:
            return None

        points_json = json.dumps([p["text"] for p in self.discussion_points])

        try:
            response = await self.client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": (
                        "You are tracking discussion progress in a live Morgan Stanley Financial Advisor–client call.\n\n"
                        "You are given the FA's pre-planned discussion points and the live transcript.\n"
                        "Determine the status of each discussion point based on what has been said.\n\n"
                        "Return a JSON object:\n"
                        '{"points": [\n'
                        '  {"text": "original point text", "status": "pending|in_progress|discussed", '
                        '"note": "optional brief note about what was said (max 8 words, or empty string)"}\n'
                        "], \n"
                        '"nudge": "If any important points have NOT been discussed and the conversation '
                        "is progressing, provide a brief nudge (max 15 words) suggesting the FA bring it up. "
                        'Otherwise empty string."}\n\n'
                        "Status meanings:\n"
                        "- pending: Not mentioned at all yet\n"
                        "- in_progress: Topic has been touched on but not fully addressed\n"
                        "- discussed: Topic has been substantially covered\n\n"
                        "RULES:\n"
                        "1. Be generous — if the topic was meaningfully discussed, mark it discussed.\n"
                        "2. Only mark in_progress if the topic was briefly mentioned but not explored.\n"
                        "3. Nudge should be conversational, like a helpful whisper to the FA.\n"
                        "4. Return ONLY valid JSON."
                    )},
                    {"role": "user", "content": (
                        f"Pre-planned discussion points:\n{points_json}\n\n"
                        f"Live transcript:\n---\n{conversation_text}\n---\n\n"
                        "Evaluate discussion progress and return JSON."
                    )},
                ],
                max_completion_tokens=400,
                temperature=0.2,
                response_format={"type": "json_object"},
            )

            raw = response.choices[0].message.content or '{"points": []}'
            result = json.loads(raw)
            points = result.get("points", [])
            nudge = result.get("nudge", "")

            if points:
                self.discussion_points = [
                    {"text": p.get("text", ""), "status": p.get("status", "pending"), "note": p.get("note", "")}
                    for p in points
                ]
                logger.info(f"DiscussionTracker: {sum(1 for p in points if p.get('status') == 'discussed')}/{len(points)} discussed")

            return {"points": self.discussion_points, "nudge": nudge}

        except Exception as e:
            logger.error(f"DiscussionTracker error: {e}", exc_info=True)
            return None


# ---------------------------------------------------------------------------
# OpenAI Realtime Transcription connection
# ---------------------------------------------------------------------------

class OpenAITranscriptionConnection:
    """
    Manages a single OpenAI Realtime Transcription WebSocket connection.

    Protocol:
      1. Connect to wss://api.openai.com/v1/realtime?intent=transcription
      2. Send transcription_session.update to configure audio format, model, VAD
      3. Stream audio as base64-encoded pcm16 via input_audio_buffer.append
      4. Receive transcript deltas (streaming) and completed events (final)
    """

    REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription"

    def __init__(
        self,
        speaker_label: str,
        on_transcript_delta,
        on_transcript_done,
        on_error=None,
        silence_duration_ms: int = 500,
        vad_threshold: float = 0.3,
        prefix_padding_ms: int = 200,
    ):
        self.speaker_label = speaker_label
        self._on_transcript_delta = on_transcript_delta
        self._on_transcript_done = on_transcript_done
        self._on_error = on_error
        self._silence_duration_ms = silence_duration_ms
        self._vad_threshold = vad_threshold
        self._prefix_padding_ms = prefix_padding_ms
        self.ws = None
        self._receive_task: asyncio.Task | None = None
        self._current_text: str = ""

    def _is_open(self) -> bool:
        if not self.ws:
            return False
        try:
            return self.ws.state == WsState.OPEN
        except AttributeError:
            return getattr(self.ws, "open", False)

    async def connect(self):
        try:
            t0 = time.time()
            self.ws = await websockets.connect(
                self.REALTIME_URL,
                additional_headers={
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                    "OpenAI-Beta": "realtime=v1",
                },
                ping_interval=5,
                ping_timeout=20,
            )
            t1 = time.time()
            logger.info(f"OpenAI WebSocket handshake [{self.speaker_label}]: {(t1-t0)*1000:.0f}ms")

            await self.ws.send(json.dumps({
                "type": "transcription_session.update",
                "session": {
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": TRANSCRIPTION_MODEL,
                        "language": "en",
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": self._vad_threshold,
                        "prefix_padding_ms": self._prefix_padding_ms,
                        "silence_duration_ms": self._silence_duration_ms,
                    },
                    "input_audio_noise_reduction": {
                        "type": "near_field",
                    },
                },
            }))

            self._receive_task = asyncio.create_task(self._receive_loop())
            logger.info(f"OpenAI Transcription connected for [{self.speaker_label}]")

        except Exception as e:
            logger.error(f"OpenAI Transcription connection failed [{self.speaker_label}]: {e}")
            if self._on_error:
                await self._on_error(
                    f"Transcription connection failed for {self.speaker_label}: {e}"
                )
            raise

    async def _receive_loop(self):
        try:
            async for message in self.ws:
                data = json.loads(message)
                event_type = data.get("type", "")

                if event_type == "conversation.item.input_audio_transcription.delta":
                    delta_text = data.get("delta", "")
                    if delta_text:
                        self._current_text += delta_text
                        await self._on_transcript_delta(
                            self._current_text, self.speaker_label
                        )

                elif event_type == "conversation.item.input_audio_transcription.completed":
                    transcript = data.get("transcript", "").strip()
                    self._current_text = ""
                    if transcript:
                        await self._on_transcript_done(transcript, self.speaker_label)

                elif event_type == "transcription_session.created":
                    logger.info(f"Transcription session created [{self.speaker_label}]")

                elif event_type == "transcription_session.updated":
                    logger.info(f"Transcription session configured [{self.speaker_label}]")

                elif event_type == "input_audio_buffer.speech_started":
                    self._current_text = ""

                elif event_type == "error":
                    error_info = data.get("error", {})
                    error_msg = error_info.get("message", str(data))
                    logger.error(
                        f"OpenAI Transcription error [{self.speaker_label}]: {error_msg}"
                    )
                    if self._on_error:
                        await self._on_error(
                            f"Transcription [{self.speaker_label}]: {error_msg}"
                        )

        except websockets.ConnectionClosed as e:
            logger.info(f"OpenAI Transcription closed [{self.speaker_label}]: {e}")
        except Exception as e:
            logger.error(f"OpenAI Transcription receive error [{self.speaker_label}]: {e}")

    async def send_audio(self, pcm_bytes: bytes):
        if self._is_open():
            try:
                audio_b64 = base64.b64encode(pcm_bytes).decode("ascii")
                await self.ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": audio_b64,
                }))
            except Exception as e:
                logger.error(
                    f"OpenAI Transcription send error [{self.speaker_label}]: {e}"
                )

    async def close(self):
        if self._is_open():
            try:
                await self.ws.close()
            except Exception:
                pass
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass


# ---------------------------------------------------------------------------
# Session: manages one advisor's audio WebSocket session
# ---------------------------------------------------------------------------

class AdvisorSession:
    """
    Manages the lifecycle of a single advisor session:
    - Bridges browser audio -> OpenAI Realtime Transcription (one connection per audio source)
    - Accumulates speaker-labeled transcript and triggers all AI engines
    - Sends transcripts, suggestions, intelligence, compliance alerts back to browser
    """

    def __init__(self, browser_ws: WebSocket):
        self.browser_ws = browser_ws

        # AI engines
        self.suggestion_engine = SuggestionEngine()
        self.intelligence_engine = IntelligenceEngine()
        self.compliance_engine = ComplianceEngine()
        self.todo_engine = TodoEngine()
        self.wordcloud_engine = WordCloudEngine()
        self.post_call_engine = PostCallEngine()

        # Transcript state
        self.conversation_lines: list[dict] = []
        self.full_transcript: str = ""
        self._session_start_time: float = time.time()
        self._first_audio_time: float = 0.0
        self._first_transcript_logged = False

        # Suggestion cooldown tracking
        self.last_suggestion_time: float = 0.0
        self.chars_at_last_suggestion: int = 0
        self._generating_suggestion = False
        self.suggestion_id_counter: int = 0

        # Intelligence cooldown tracking
        self.last_intelligence_time: float = 0.0
        self.chars_at_last_intelligence: int = 0
        self._generating_intelligence = False

        # Compliance cooldown tracking
        self.last_compliance_time: float = 0.0
        self.chars_at_last_compliance: int = 0
        self._running_compliance = False

        # Todo cooldown tracking
        self.last_todo_time: float = 0.0
        self.chars_at_last_todo: int = 0
        self._running_todo = False

        # Word cloud cooldown tracking
        self.last_wordcloud_time: float = 0.0
        self.chars_at_last_wordcloud: int = 0
        self._running_wordcloud = False

        # Discussion tracker engine
        self.discussion_tracker = DiscussionTrackerEngine()
        self.last_tracker_time: float = 0.0
        self.chars_at_last_tracker: int = 0
        self._running_tracker = False

        # Client context (injected from pre-call prep, if available)
        self.client_context: dict | None = None
        self._client_context_prompt: str = ""

        # Transcription connections keyed by source byte
        self.transcription_connections: dict[int, OpenAITranscriptionConnection] = {}

        # Mode flags
        self.coaching_mode: bool = False
        self.simulation_mode: bool = False
        self._simulation_turn: int = 0  # alternates speaker labels

    # -- Browser communication helpers ------------------------------------

    async def send_to_browser(self, payload: dict):
        try:
            await self.browser_ws.send_json(payload)
        except Exception as e:
            logger.warning(f"send_to_browser failed ({payload.get('type', '?')}): {e}")

    # -- Client context setup ------------------------------------------------

    def set_client_context(self, client_data: dict, discussion_points: list[str] | None = None):
        self.client_context = client_data
        if discussion_points:
            self.discussion_tracker.set_points(discussion_points)

        name = client_data.get("name", "Unknown")
        tier = client_data.get("client_tier", "Unknown")
        aum = client_data.get("total_aum", 0)
        risk = client_data.get("risk_profile", "unknown")

        accounts_text = ""
        for acct in client_data.get("accounts", []):
            flags_text = f" FLAGS: {', '.join(acct['flags'])}" if acct.get("flags") else ""
            accounts_text += (
                f"  - {acct['name']} ({acct['type']}, {acct.get('program', 'N/A')}): "
                f"${acct['value']:,.0f} — {acct.get('holdings_summary', 'N/A')}"
                f"{' [Total Tax 365 enrolled]' if acct.get('total_tax_365') else ''}"
                f"{flags_text}\n"
            )

        goals_text = ""
        for goal in client_data.get("gps_goals", []):
            status = "ON TRACK" if goal.get("on_track") else "BEHIND"
            goals_text += (
                f"  - {goal['name']}: {goal['current_progress']}% toward "
                f"${goal.get('target', 0):,.0f} by {goal.get('timeline', '?')} [{status}]\n"
            )

        personal = client_data.get("personal", {})
        personal_text = ""
        if personal.get("family"):
            personal_text += f"  Family: {'; '.join(personal['family'])}\n"
        if personal.get("career"):
            personal_text += f"  Career: {personal['career']}\n"
        if personal.get("life_events"):
            personal_text += f"  Life Events: {'; '.join(personal['life_events'])}\n"
        if personal.get("interests"):
            personal_text += f"  Interests: {'; '.join(personal['interests'])}\n"

        past_conv_text = ""
        for conv in client_data.get("past_conversations", [])[:2]:
            past_conv_text += f"  [{conv['date']}] {conv['summary']}\n"

        self._client_context_prompt = (
            f"\n=== CLIENT CONTEXT (from Morgan Stanley CRM) ===\n"
            f"Client: {name} | Tier: {tier} | AUM: ${aum:,.0f} | Risk: {risk}\n"
            f"Compliance: {client_data.get('compliance_notes', 'N/A')}\n\n"
            f"ACCOUNTS:\n{accounts_text}\n"
            f"GPS GOALS:\n{goals_text}\n"
            f"PERSONAL DETAILS:\n{personal_text}\n"
            f"RECENT CONVERSATIONS:\n{past_conv_text}"
            f"=== END CLIENT CONTEXT ===\n"
        )
        logger.info(f"Client context set: {name} (AUM: ${aum:,.0f}, Tier: {tier})")

    async def suggest_discussion_points(self):
        """Use GPT to suggest discussion points based on client context and any available transcript."""
        context = self._client_context_prompt or ""
        transcript = self.full_transcript.strip()

        user_prompt = ""
        if context:
            user_prompt += f"Client context:\n{context}\n\n"
        if transcript:
            user_prompt += f"Conversation so far:\n---\n{transcript}\n---\n\n"
        if not context and not transcript:
            user_prompt = "No client data or conversation available yet. Suggest generic discussion points for a financial advisory call.\n"

        user_prompt += "Suggest 4-5 key discussion points for this call."

        try:
            client = AsyncOpenAI(api_key=OPENAI_API_KEY)
            response = await client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": (
                        MS_KNOWLEDGE_BASE + "\n\n"
                        "You are a Morgan Stanley FA call preparation assistant.\n"
                        "Based on the client's portfolio, goals, recent conversations, and any live transcript, "
                        "suggest 4-5 specific, actionable discussion points for this call.\n\n"
                        "Each point should be concise (8-15 words) and specific to the client's situation.\n"
                        "If no client data is available, suggest standard quarterly review topics.\n\n"
                        "Return JSON: {\"points\": [\"point 1\", \"point 2\", ...]}\n"
                        "Return ONLY valid JSON."
                    )},
                    {"role": "user", "content": user_prompt},
                ],
                max_completion_tokens=300,
                temperature=0.4,
                response_format={"type": "json_object"},
            )

            raw = response.choices[0].message.content or '{"points": []}'
            result = json.loads(raw)
            points = result.get("points", [])
            logger.info(f"Discussion suggestions generated: {len(points)} points")
            return points

        except Exception as e:
            logger.error(f"Discussion suggestion error: {e}", exc_info=True)
            return []

    def _build_transcript_with_context(self) -> str:
        if self._client_context_prompt:
            return self._client_context_prompt + "\n" + self.full_transcript
        return self.full_transcript

    # -- Transcription connections ------------------------------------------

    async def _send_error_to_browser(self, error_msg: str):
        await self.send_to_browser({"type": "error", "message": error_msg})

    async def connect_source(self, source_id: int):
        label = SPEAKER_LABELS.get(source_id, f"Source-{source_id}")

        if self.simulation_mode:
            # Simulation: single audio source with both speakers mixed.
            # Use very short silence detection (300ms) and low threshold
            # so VAD splits on the brief natural pauses between speakers.
            # This creates more, shorter segments that better match turns.
            silence_ms = 300
            vad_threshold = 0.2
            prefix_padding = 100
        else:
            # Live mode: separate mic/speaker streams, speaker identity
            # is known from the source. Normal VAD settings.
            silence_ms = 500
            vad_threshold = 0.3
            prefix_padding = 200

        conn = OpenAITranscriptionConnection(
            speaker_label=label,
            on_transcript_delta=self._handle_transcript_delta,
            on_transcript_done=self._handle_transcript_done,
            on_error=self._send_error_to_browser,
            silence_duration_ms=silence_ms,
            vad_threshold=vad_threshold,
            prefix_padding_ms=prefix_padding,
        )
        await conn.connect()
        self.transcription_connections[source_id] = conn
        await self.send_to_browser({
            "type": "status",
            "message": f"{label} transcription connected",
        })

    # -- Audio routing -----------------------------------------------------

    async def route_audio(self, raw_packet: bytes):
        if len(raw_packet) < 2:
            return
        source_id = raw_packet[0]
        pcm_data = raw_packet[1:]
        conn = self.transcription_connections.get(source_id)
        if conn:
            if self._first_audio_time == 0.0:
                self._first_audio_time = time.time()
                elapsed = (self._first_audio_time - self._session_start_time) * 1000
                logger.info(f"First audio packet received: {elapsed:.0f}ms after session start")
            await conn.send_audio(pcm_data)

    # -- Transcript handling -----------------------------------------------

    async def _handle_transcript_delta(self, accumulated_text: str, speaker_label: str):
        # Log time to first interim transcript
        if not self._first_transcript_logged and self._first_audio_time > 0:
            latency = (time.time() - self._first_audio_time) * 1000
            total = (time.time() - self._session_start_time) * 1000
            logger.info(f"First transcript delta: {latency:.0f}ms after first audio, {total:.0f}ms total")
            self._first_transcript_logged = True

        # In simulation mode, show current turn's speaker label for interim text
        if self.simulation_mode:
            speaker_label = "Advisor" if self._simulation_turn % 2 == 0 else "Client"

        await self.send_to_browser({
            "type": "transcript",
            "text": accumulated_text,
            "is_final": False,
            "speaker": speaker_label,
        })

    async def _handle_transcript_done(self, transcript: str, speaker_label: str):
        # Log time to first transcript
        if not self._first_transcript_logged and self._first_audio_time > 0:
            latency = (time.time() - self._first_audio_time) * 1000
            total = (time.time() - self._session_start_time) * 1000
            logger.info(f"First transcript: {latency:.0f}ms after first audio, {total:.0f}ms total from session start")
            self._first_transcript_logged = True

        # In simulation mode, alternate speaker labels since all audio
        # comes from a single source (recorded conversation)
        if self.simulation_mode:
            speaker_label = "Advisor" if self._simulation_turn % 2 == 0 else "Client"
            self._simulation_turn += 1

        await self.send_to_browser({
            "type": "transcript",
            "text": transcript,
            "is_final": True,
            "speaker": speaker_label,
        })

        self.conversation_lines.append({
            "speaker": speaker_label,
            "text": transcript,
        })
        self.full_transcript = "\n".join(
            f"{line['speaker']}: {line['text']}"
            for line in self.conversation_lines
        )

        # Trigger all AI engines concurrently
        await self._maybe_generate_suggestion()
        await self._maybe_generate_intelligence()
        await self._maybe_run_compliance()
        await self._maybe_extract_todos()
        await self._maybe_generate_wordcloud()
        await self._maybe_update_discussion_tracker()

    # -- Suggestion generation ---------------------------------------------

    async def _maybe_generate_suggestion(self):
        now = time.time()
        elapsed = now - self.last_suggestion_time
        new_chars = len(self.full_transcript) - self.chars_at_last_suggestion

        if elapsed < SUGGESTION_COOLDOWN_SECONDS:
            return
        if new_chars < MIN_NEW_CHARS_FOR_SUGGESTION:
            return
        if not self.full_transcript.strip():
            return
        if self._generating_suggestion:
            return

        logger.info(f"Triggering suggestion (new_chars={new_chars}, elapsed={elapsed:.1f}s)")
        self._generating_suggestion = True
        asyncio.create_task(self._run_suggestion())

    async def _run_suggestion(self):
        try:
            self.suggestion_id_counter += 1
            suggestion_id = f"sug_{self.suggestion_id_counter}"

            result = await self.suggestion_engine.generate(
                self._build_transcript_with_context(), coaching_mode=self.coaching_mode
            )

            if result:
                logger.info(f"[{suggestion_id}] Suggestion: {result}")
                await self.send_to_browser({
                    "type": "suggestion_start",
                    "id": suggestion_id,
                })
                await self.send_to_browser({
                    "type": "suggestion_chunk",
                    "id": suggestion_id,
                    "text": result,
                })
                await self.send_to_browser({
                    "type": "suggestion_done",
                    "id": suggestion_id,
                    "had_suggestion": True,
                })

            self.last_suggestion_time = time.time()
            self.chars_at_last_suggestion = len(self.full_transcript)

        except Exception as e:
            logger.error(f"Suggestion error: {e}", exc_info=True)
        finally:
            self._generating_suggestion = False

    # -- Intelligence generation -------------------------------------------

    async def _maybe_generate_intelligence(self):
        now = time.time()
        elapsed = now - self.last_intelligence_time
        new_chars = len(self.full_transcript) - self.chars_at_last_intelligence

        if elapsed < INTELLIGENCE_COOLDOWN_SECONDS:
            return
        if new_chars < MIN_NEW_CHARS_FOR_INTELLIGENCE:
            return
        if not self.full_transcript.strip():
            return
        if self._generating_intelligence:
            return

        logger.info(f"Triggering intelligence (new_chars={new_chars}, elapsed={elapsed:.1f}s)")
        self._generating_intelligence = True
        asyncio.create_task(self._run_intelligence())

    async def _run_intelligence(self):
        try:
            result = await self.intelligence_engine.analyze(self._build_transcript_with_context())

            # Only send if the response has actual content
            has_profile = any(result.get(k) for k in ("family", "life_events", "interests", "career"))
            has_intel = result.get("sentiment") or result.get("key_concerns")
            if result and (has_profile or has_intel):
                family = result.get("family", [])
                life_events = result.get("life_events", [])
                interests = result.get("interests", [])
                career = result.get("career", [])
                concerns = result.get("key_concerns", [])
                referrals = result.get("referral_opportunities", [])
                logger.info(
                    f"Intelligence update: sentiment={result.get('sentiment')}, "
                    f"risk={result.get('risk_profile')}, "
                    f"family={len(family)}, life_events={len(life_events)}, "
                    f"interests={len(interests)}, career={len(career)}, "
                    f"concerns={len(concerns)}, referrals={len(referrals)}"
                )
                if family:
                    logger.info(f"  Family: {family}")
                if life_events:
                    logger.info(f"  Life events: {life_events}")
                await self.send_to_browser({
                    "type": "intelligence_update",
                    **result,
                })
            else:
                logger.info(f"Intelligence returned empty/no-content response — skipped. Keys: {list(result.keys()) if result else 'None'}")

            self.last_intelligence_time = time.time()
            self.chars_at_last_intelligence = len(self.full_transcript)

        except Exception as e:
            logger.error(f"Intelligence error: {e}", exc_info=True)
        finally:
            self._generating_intelligence = False

    # -- Compliance scanning -----------------------------------------------

    async def _maybe_run_compliance(self):
        now = time.time()
        elapsed = now - self.last_compliance_time
        new_chars = len(self.full_transcript) - self.chars_at_last_compliance

        if elapsed < COMPLIANCE_COOLDOWN_SECONDS:
            return
        if new_chars < MIN_NEW_CHARS_FOR_COMPLIANCE:
            return
        if not self.full_transcript.strip():
            return
        if self._running_compliance:
            return

        logger.info(f"Triggering compliance (new_chars={new_chars}, elapsed={elapsed:.1f}s)")
        self._running_compliance = True
        asyncio.create_task(self._run_compliance_scan())

    async def _run_compliance_scan(self):
        try:
            flags = await self.compliance_engine.scan(self._build_transcript_with_context())

            if not flags:
                logger.info("Compliance scan: no issues found (clean)")

            for flag in flags:
                logger.info(
                    f"Compliance flag: [{flag.get('severity')}] {flag.get('issue')}"
                )
                await self.send_to_browser({
                    "type": "compliance_alert",
                    "severity": flag.get("severity", "warning"),
                    "issue": flag.get("issue", ""),
                    "recommendation": flag.get("recommendation", ""),
                })

            self.last_compliance_time = time.time()
            self.chars_at_last_compliance = len(self.full_transcript)

        except Exception as e:
            logger.error(f"Compliance error: {e}", exc_info=True)
        finally:
            self._running_compliance = False

    # -- Todo extraction ---------------------------------------------------

    async def _maybe_extract_todos(self):
        now = time.time()
        elapsed = now - self.last_todo_time
        new_chars = len(self.full_transcript) - self.chars_at_last_todo

        if elapsed < TODO_COOLDOWN_SECONDS:
            return
        if new_chars < MIN_NEW_CHARS_FOR_TODO:
            return
        if not self.full_transcript.strip():
            return
        if self._running_todo:
            return

        logger.info(f"Triggering todo extraction (new_chars={new_chars}, elapsed={elapsed:.1f}s)")
        self._running_todo = True
        asyncio.create_task(self._run_todo_extraction())

    async def _run_todo_extraction(self):
        try:
            new_items = await self.todo_engine.extract(self._build_transcript_with_context())

            if new_items:
                logger.info(f"Todo items: {new_items}")
                await self.send_to_browser({
                    "type": "todo_update",
                    "items": new_items,
                })

            self.last_todo_time = time.time()
            self.chars_at_last_todo = len(self.full_transcript)

        except Exception as e:
            logger.error(f"Todo extraction error: {e}", exc_info=True)
        finally:
            self._running_todo = False

    # -- Word cloud generation ---------------------------------------------

    async def _maybe_generate_wordcloud(self):
        now = time.time()
        elapsed = now - self.last_wordcloud_time
        new_chars = len(self.full_transcript) - self.chars_at_last_wordcloud

        if elapsed < WORDCLOUD_COOLDOWN_SECONDS:
            return
        if new_chars < MIN_NEW_CHARS_FOR_WORDCLOUD:
            return
        if not self.full_transcript.strip():
            return
        if self._running_wordcloud:
            return

        logger.info(f"Triggering word cloud (new_chars={new_chars}, elapsed={elapsed:.1f}s)")
        self._running_wordcloud = True
        asyncio.create_task(self._run_wordcloud())

    async def _run_wordcloud(self):
        try:
            result = await self.wordcloud_engine.analyze(self._build_transcript_with_context())

            if result and result.get("topics"):
                logger.info(f"Word cloud: {len(result['topics'])} topics")
                await self.send_to_browser({
                    "type": "word_cloud_update",
                    "topics": result["topics"],
                })

            self.last_wordcloud_time = time.time()
            self.chars_at_last_wordcloud = len(self.full_transcript)

        except Exception as e:
            logger.error(f"Word cloud error: {e}", exc_info=True)
        finally:
            self._running_wordcloud = False

    # -- Discussion tracker ------------------------------------------------

    async def _maybe_update_discussion_tracker(self):
        if not self.discussion_tracker.discussion_points:
            return

        now = time.time()
        elapsed = now - self.last_tracker_time
        new_chars = len(self.full_transcript) - self.chars_at_last_tracker

        if elapsed < DiscussionTrackerEngine.TRACKER_COOLDOWN_SECONDS:
            return
        if new_chars < DiscussionTrackerEngine.MIN_NEW_CHARS:
            return
        if not self.full_transcript.strip():
            return
        if self._running_tracker:
            return

        logger.info(f"Triggering discussion tracker (new_chars={new_chars}, elapsed={elapsed:.1f}s)")
        self._running_tracker = True
        asyncio.create_task(self._run_discussion_tracker())

    async def _run_discussion_tracker(self):
        try:
            result = await self.discussion_tracker.evaluate(self.full_transcript)

            if result:
                await self.send_to_browser({
                    "type": "discussion_tracker_update",
                    "points": result["points"],
                    "nudge": result.get("nudge", ""),
                })

            self.last_tracker_time = time.time()
            self.chars_at_last_tracker = len(self.full_transcript)

        except Exception as e:
            logger.error(f"Discussion tracker error: {e}", exc_info=True)
        finally:
            self._running_tracker = False

    # -- Post-call summary -------------------------------------------------

    async def generate_post_call_summary(self):
        transcript_len = len(self.full_transcript.strip())
        logger.info(f"generate_post_call_summary called, transcript length: {transcript_len} chars")

        if not transcript_len:
            logger.warning("No transcript to summarize — sending error to browser")
            await self.send_to_browser({
                "type": "post_call_summary",
                "error": "No transcript to summarize",
            })
            return

        logger.info("Generating post-call summary...")
        await self.send_to_browser({
            "type": "status",
            "message": "Generating post-call summary...",
        })

        t0 = time.time()
        try:
            result = await self.post_call_engine.generate_summary(self._build_transcript_with_context())
        except Exception as e:
            logger.error(f"PostCallEngine exception: {e}", exc_info=True)
            result = None
        elapsed = (time.time() - t0) * 1000

        if result:
            keys = list(result.keys())
            logger.info(f"Post-call summary generated in {elapsed:.0f}ms, keys: {keys}")
            await self.send_to_browser({"type": "post_call_summary", **result})
            logger.info("Post-call summary sent to browser successfully")
        else:
            logger.error(f"Post-call summary FAILED after {elapsed:.0f}ms — sending error to browser")
            await self.send_to_browser({
                "type": "post_call_summary",
                "error": "Failed to generate summary",
            })

    # -- Cleanup -----------------------------------------------------------

    async def close(self):
        for conn in self.transcription_connections.values():
            await conn.close()
        self.transcription_connections.clear()
        logger.info("Session closed")


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws/audio")
async def audio_websocket(websocket: WebSocket):
    """
    Main WebSocket endpoint.

    Protocol:
      Browser -> Server:
        - JSON config:  { type: "config", sampleRate, sources }
        - Binary audio: [sourceID byte][PCM int16 data]
        - JSON ping:    { type: "ping" }
        - JSON:         { type: "coaching_mode", enabled: bool }
        - JSON:         { type: "generate_summary" }

      Server -> Browser:
        - { type: "transcript", text, is_final, speaker }
        - { type: "suggestion_start", id }
        - { type: "suggestion_chunk", id, text }
        - { type: "suggestion_done", id, had_suggestion }
        - { type: "intelligence_update", family, life_events, sentiment, risk_profile, ... }
        - { type: "word_cloud_update", topics: [{ text, weight, tone }] }
        - { type: "compliance_alert", severity, issue, recommendation }
        - { type: "todo_update", items: [...] }
        - { type: "post_call_summary", summary, follow_up_email, action_items, ... }
        - { type: "status", message }
        - { type: "error", message }
    """
    await websocket.accept()
    logger.info("Browser WebSocket connected")

    session = AdvisorSession(websocket)

    try:
        config_raw = await websocket.receive_text()
        config = json.loads(config_raw)
        if config.get("type") == "config":
            sources = config.get("sources", ["mic"])
            sample_rate = config.get("sampleRate", 24000)
            mode = config.get("mode", "live")
            logger.info(f"Audio config: sampleRate={sample_rate}, sources={sources}, mode={mode}")

            if mode == "simulation":
                session.simulation_mode = True
                await session.connect_source(SOURCE_SPEAKER)
            else:
                if "mic" in sources:
                    await session.connect_source(SOURCE_MIC)
                if "speaker" in sources:
                    await session.connect_source(SOURCE_SPEAKER)

        while True:
            message = await websocket.receive()
            if "bytes" in message:
                await session.route_audio(message["bytes"])
            elif "text" in message:
                data = json.loads(message["text"])
                msg_type = data.get("type")
                if msg_type == "ping":
                    await session.send_to_browser({"type": "pong"})
                elif msg_type == "coaching_mode":
                    session.coaching_mode = data.get("enabled", False)
                    logger.info(f"Coaching mode: {session.coaching_mode}")
                elif msg_type == "client_context":
                    client_id = data.get("client_id", "")
                    discussion_points = data.get("discussion_points", [])
                    clients = _load_clients()
                    client_data = next((c for c in clients if c["id"] == client_id), None)
                    if client_data:
                        session.set_client_context(client_data, discussion_points)
                        logger.info(f"Client context loaded: {client_data['name']} with {len(discussion_points)} discussion points")
                        await session.send_to_browser({
                            "type": "discussion_tracker_update",
                            "points": session.discussion_tracker.discussion_points,
                            "nudge": "",
                        })
                    else:
                        logger.warning(f"Client not found: {client_id}")
                elif msg_type == "set_discussion_points":
                    discussion_points = data.get("discussion_points", [])
                    if discussion_points:
                        session.discussion_tracker.set_points(discussion_points)
                        logger.info(f"Discussion points set (no client context): {len(discussion_points)} points")
                        await session.send_to_browser({
                            "type": "discussion_tracker_update",
                            "points": session.discussion_tracker.discussion_points,
                            "nudge": "",
                        })
                elif msg_type == "request_discussion_suggestions":
                    logger.info("Received request for AI discussion suggestions")
                    async def _send_suggestions():
                        points = await session.suggest_discussion_points()
                        if points:
                            session.discussion_tracker.set_points(points)
                            await session.send_to_browser({
                                "type": "discussion_suggestions",
                                "points": points,
                            })
                    asyncio.create_task(_send_suggestions())
                elif msg_type == "generate_summary":
                    logger.info("Received generate_summary request from browser")
                    asyncio.create_task(session.generate_post_call_summary())

    except WebSocketDisconnect:
        logger.info("Browser disconnected")
    except Exception as e:
        # "Cannot call receive once a disconnect message" is normal on close
        if "disconnect" in str(e).lower():
            logger.info("Browser disconnected (receive after close)")
        else:
            logger.error(f"WebSocket error: {e}")
    finally:
        await session.close()


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8001,
        reload=True,
        log_level="info",
    )
