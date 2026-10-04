/**
 * Deterministic "the customer is asking for a human" detector.
 *
 * The LLM is told to hand off when a customer asks for a person, but a
 * model can miss it (or answer anyway). A clear request for a human must
 * ALWAYS reach one, so this runs BEFORE the model: on a match the bot
 * skips normal answering and goes straight to the handoff.
 *
 * Deliberately conservative — every pattern needs a REQUEST shape
 * (verb + person-word, or an explicit "agent assign" phrase), never a
 * bare noun, so "I'm a travel agent", "human resources" or "great
 * agent, thanks!" do not trigger it. Covers English, Hinglish, Hindi
 * (Devanagari), Spanish, Portuguese and Korean — the app's locales plus
 * the way Indian customers actually type.
 *
 * A false negative is safe (the model's own handoff rule is the
 * backstop); a false positive only means a human sees a chat the bot
 * could have answered, so the bias is toward precision.
 */

// person-words a customer might ask for
const EN_PERSON =
  '(?:human|real person|live person|person|agent|representative|rep|executive|manager|supervisor|someone|somebody|team member|support|customer care|customer service|staff|owner)'
const EN_VERB =
  '(?:talk|speak|chat|connect|transfer|escalate|get|put|need|want|assign|call|reach|contact)'

const PATTERNS: RegExp[] = [
  // "I want to talk to a human", "connect me with an agent", "speak to your manager"
  new RegExp(`\\b${EN_VERB}\\b[^.!?\\n]{0,30}\\b${EN_PERSON}\\b`, 'i'),
  // "human please", "agent please", "live agent", "real person"
  /\b(?:human|agent|representative|executive|manager)\s+(?:please|pls|plz)\b/i,
  /\b(?:live|human|real)\s+(?:agent|person|support|help)\b/i,
  // "assign an agent", "agent assign kar do", "assign me someone"
  /\bassign\b[^.!?\n]{0,20}\b(?:agent|human|person|someone|executive|manager|representative)\b/i,
  /\b(?:agent|executive|manager|representative)\b[^.!?\n]{0,15}\bassign\b/i,

  // Hinglish: "agent se baat karni hai", "kisi insaan se baat", "manager ko bulao"
  /\b(?:agent|executive|manager|representative|insaan|insan|banda|bande|admi|aadmi|koi\s+person|team|owner|malik)\b[^.!?\n]{0,15}\b(?:se|ko)\b[^.!?\n]{0,15}\b(?:baat|bat|connect|milao|milwao|bulao|bhejo)\b/i,
  /\b(?:baat|bat)\s+(?:karni|karna|karwa|karao|karva)\b[^.!?\n]{0,25}\b(?:agent|executive|manager|insaan|insan|banda|person|team|owner)\b/i,

  // Hindi (Devanagari)
  /(?:एजेंट|एजेन्ट|मैनेजर|इंसान|इन्सान|कस्टमर\s*केयर|एग्जीक्यूटिव|प्रतिनिधि)[^.!?\n]{0,20}(?:बात|कनेक्ट|जोड़|मिला|बुला)/,
  /(?:बात|कनेक्ट)[^.!?\n]{0,20}(?:एजेंट|एजेन्ट|मैनेजर|इंसान|इन्सान|एग्जीक्यूटिव)/,

  // Spanish
  /\b(?:hablar|comunicar(?:me)?|contactar|pasar(?:me)?|transferir)\b[^.!?\n]{0,30}\b(?:agente|humano|persona|asesor|representante|gerente|encargado|alguien)\b/i,
  // Portuguese
  /\b(?:falar|conversar|chamar|transferir|passar)\b[^.!?\n]{0,30}\b(?:atendente|humano|pessoa|agente|gerente|representante|alguém|alguem)\b/i,

  // Korean
  /(?:상담원|담당자|직원|매니저|사람)[^.!?\n]{0,10}(?:연결|통화|상담|바꿔|말하)/,
  /(?:연결|상담|통화)[^.!?\n]{0,10}(?:상담원|담당자|직원|매니저)/,
]

export function detectHumanRequest(text: string | null | undefined): boolean {
  if (!text) return false
  // Cap the scan: a customer message is short; a megabyte of input must
  // not turn this into a regex-cost vector.
  const t = text.slice(0, 600)
  return PATTERNS.some((re) => re.test(t))
}