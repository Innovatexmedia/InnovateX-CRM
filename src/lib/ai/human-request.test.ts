import { describe, it, expect } from 'vitest'
import { detectHumanRequest } from './human-request'

describe('detectHumanRequest — requests that must reach a human', () => {
  const positives = [
    // English
    'I want to talk to a human',
    'Can I speak to your manager?',
    'please connect me with an agent',
    'transfer me to a real person',
    'I need a live agent',
    'human please',
    'agent please!',
    'assign an agent to me',
    'can you assign someone to my chat',
    'I want customer support executive',
    // Hinglish
    'agent se baat karni hai',
    'mujhe kisi insaan se baat karni hai',
    'manager ko bulao',
    'baat karwa do agent se',
    'agent assign kar do',
    // Hindi
    'मुझे एजेंट से बात करनी है',
    'कस्टमर केयर से बात कराओ',
    'मैनेजर से कनेक्ट करो',
    // Spanish / Portuguese / Korean
    'quiero hablar con un agente',
    'necesito comunicarme con una persona',
    'quero falar com um atendente',
    'preciso conversar com uma pessoa',
    '상담원 연결해 주세요',
    '담당자와 통화하고 싶어요',
  ]
  for (const msg of positives) {
    it(`detects: ${msg}`, () => {
      expect(detectHumanRequest(msg)).toBe(true)
    })
  }
})

describe('detectHumanRequest — ordinary messages must NOT trigger', () => {
  const negatives = [
    'Hi',
    'What are your prices?',
    'I am a travel agent and want to partner with you',
    'Do you offer human resources software?',
    'great agent, thanks for the help!',
    'The manager of my shop wants a quote',
    'Is the support available on Sunday?',
    'my order id is 1042',
    'thank you so much',
    'kya price hai?',
    // Everyday phrases that used to wrongly hand the chat to a human
    'I need an executive summary of the workshop',
    'I want to be an agent for your company',
    'I want to get the owner details of this flat',
    'I am not participated',
    'Do you want to join the workshop again? Yes',
    'I need support with the payment link',
    'can you call me tomorrow at 5pm',
    'send me the details of the team',
    'I will get someone to join with me',
    'please share the staff schedule',
    'mujhe product chahiye',
    '',
  ]
  for (const msg of negatives) {
    it(`ignores: "${msg}"`, () => {
      expect(detectHumanRequest(msg)).toBe(false)
    })
  }

  it('handles null / undefined', () => {
    expect(detectHumanRequest(null)).toBe(false)
    expect(detectHumanRequest(undefined)).toBe(false)
  })

  it('does not choke on a huge message', () => {
    const big = 'a '.repeat(500_000)
    const t0 = Date.now()
    expect(detectHumanRequest(big)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})