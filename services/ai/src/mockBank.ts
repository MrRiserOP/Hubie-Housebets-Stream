/**
 * DEMO-MODE brain (no OpenAI key). Hand-written, compositional lines:
 * opener × core × tag with real numbers from the game, plus stories, jokes,
 * questions and callbacks. Candidates are screened by the variety guard so the
 * same phrasing doesn't come back. The real experience uses OpenAI; this keeps
 * the stream watchable without credentials and is the outage fallback.
 */
import type { CaptionStyle, Combo, Emotion, Expression } from '../../../packages/shared/src/protocol.ts';
import type { LineOut, Situation, LLMContext, SpontaneousMode } from './types.ts';
import { judgeVariety } from './variety.ts';

type T = { t: string; e: Expression; v: Emotion; c?: Combo };
const R = (t: string, e: Expression, v: Emotion, c?: Combo): T => ({ t, e, v, c });
const pick = <X,>(a: X[]) => a[Math.floor(Math.random() * a.length)];
const chance = (p: number) => Math.random() < p;
const fx = (n?: number) => (n === undefined || !Number.isFinite(n) ? '' : n >= 100 ? `${Math.round(n)}x` : `${Number(n.toFixed(2))}x`);

/* ───────────── round pieces ───────────── */
const OPENERS = ['Right.', 'Okay so,', 'Chat,', 'Look,', 'For the record,', 'Small update:', 'Breaking news:', 'Plot twist:', 'Not gonna lie,', 'Honestly,', 'Fun fact:', 'Quick recap:', 'Mm.', 'So.', 'Alright,', 'Listen,', 'In today\'s episode,', 'Official statement:'];
const LOSS_TAGS = ["Let's pretend that never happened.", 'Moving on.', 'Deep breaths.', 'We regroup.', 'The hat remains optimistic.', 'Play money, real feelings.', "I'm fine. Totally fine.", 'Back to it.', 'Noted.', 'Unbothered. Mostly.', 'Character building.', "We don't dwell. Slowly, we don't dwell.", 'The bow tie stays straight though.'];
const BIG_TAGS = ['Someone check the cameras. The sloth is cooking today!', 'I might actually need to stand up for this one.', 'Best moment of the night so far!', 'I need to sit down. I am sitting down.', 'Somebody frame that number.', 'The hat is shaking!', 'Round {n}, never forget it.'];
const WIN_TAGS = ["I'm a sloth, not a millionaire.", 'Smooth.', 'Classy.', 'We take those.', 'Bow tie: straightened.', 'Hat: tipped.', 'Very civilised.', 'Stay humble, Hubie.', 'Chat, act natural.', 'Love to see it.'];

const LOSS_CORE: T[] = [
  R('{rolled} on a {target} target. The game is clearly toying with me.', 'suspicious', 'sarcastic', 'suspicious'),
  R('the {target} dream lasted about as long as my motivation on a Monday.', 'disappointed', 'sarcastic', 'bad_result'),
  R('we asked for {target}, the game delivered {rolled}. Customer service, please.', 'disappointed', 'sarcastic', 'shrug'),
  R('{rolled}. I have seen sloths move faster than that multiplier, and I am the sloth.', 'disappointed', 'playful', 'bad_result'),
  R('the game looked me in the eyes and said {rolled}. Bold. Disrespectful. But bold.', 'suspicious', 'sarcastic', 'suspicious'),
  R('missed the {target}. My hat felt that one personally.', 'sad', 'disappointed', 'hat_tip'),
  R('{rolled}. Writing that down in my little diary of betrayals.', 'mischievous', 'sarcastic', 'mischief'),
  R('the multiplier stopped at {rolled}, which is roughly where I stop on a staircase.', 'disappointed', 'playful', 'shrug'),
  R('we were aiming for {target}. We got a polite little {rolled}. Thanks, I guess.', 'disappointed', 'sarcastic', 'bad_result'),
  R('my bow tie just loosened itself in protest.', 'disappointed', 'sarcastic', 'bow_tie'),
  R("that round has been sent to sit on the naughty branch.", 'angry', 'playful', 'facepalm'),
  R('{rolled}? I blinked slowly and missed the whole thing. Probably for the best.', 'sleepy', 'sleepy', 'sleepy'),
  R("round {n}. The game and I are now in a complicated relationship.", 'thinking', 'sarcastic', 'thinking'),
  R("{target} was the plan. {rolled} was the reality. Story of my life, honestly.", 'sad', 'disappointed', 'shrug'),
  R("I'm not saying the game is rigged against sloths. I'm just saying it never calls.", 'suspicious', 'mischievous', 'suspicious'),
  R("that multiplier gave up faster than I do on a jog.", 'laughing', 'playful', 'laughing'),
  R("{rolled}. The universe really looked at a sloth in a tuxedo and said, not today.", 'disappointed', 'dramatic', 'bad_result'),
  R("missed it. Somewhere, a hibiscus flower is crying with me.", 'sad', 'dramatic', 'facepalm'),
  R("{rolled} out of a needed {target}. I'll allow it, but I won't enjoy it.", 'disappointed', 'sarcastic', 'shrug'),
  R("the game just did a little dance on my dreams. Cute moves though.", 'mischievous', 'sarcastic', 'mischief'),
  R("that one didn't land. I'm choosing to blame the lighting.", 'thinking', 'playful', 'shrug'),
  R("no luck at {target}. My tailor will hear about this.", 'disappointed', 'playful', 'bow_tie'),
  R("{rolled}. Even my algae is disappointed, and it lives rent-free in my fur.", 'laughing', 'playful', 'laughing'),
  R("the {target} target stays undefeated. For now. Dramatic pause. Mostly for now.", 'confident', 'dramatic', 'confident'),
];
const LOSS_BRIEF: T[] = [
  R('{rolled}. Not quite the {target} we ordered.', 'disappointed', 'relaxed', 'shrug'),
  R('Short of {target}. Next.', 'idle', 'relaxed'),
  R('{rolled}, so close to effort, so far from {target}.', 'mischievous', 'playful', 'mischief'),
  R("Missed. I'll be thinking about it at sloth speed.", 'sleepy', 'relaxed', 'sleepy'),
  R("{rolled}. The game's having fun at least.", 'suspicious', 'sarcastic'),
  R("Not this one. The bow tie stays calm.", 'confident', 'relaxed', 'bow_tie'),
  R("{rolled}. Filed under: things we don't mention.", 'mischievous', 'sarcastic'),
  R("That fell short. Hat tilt of mild disapproval.", 'disappointed', 'playful', 'hat_tip'),
  R("No {target} for us. Moving at my usual pace.", 'idle', 'relaxed'),
  R("{rolled}. Cute. Wrong, but cute.", 'mischievous', 'sarcastic', 'mischief'),
  R('{rolled} instead of {target}. The game is in a mood.', 'suspicious', 'sarcastic', 'suspicious'),
  R('Round {n}, no dice. Well, no {target}.', 'idle', 'relaxed', 'shrug'),
  R('{rolled}. Close-ish. Emphasis on ish.', 'mischievous', 'playful'),
  R("Didn't reach {target}. My patience, however, is infinite. Sloth perk.", 'confident', 'relaxed', 'confident'),
  R('{rolled}, and the hat remains unimpressed.', 'disappointed', 'sarcastic', 'hat_tip'),
  R('A {rolled}. The game is clearly saving the good stuff.', 'suspicious', 'mischievous', 'suspicious'),
  R("{rolled}. We'll call that a warm-up.", 'confident', 'playful', 'nod'),
  R('Miss at {rolled}. I blinked. Slowly. It still missed.', 'sleepy', 'sleepy', 'sleepy'),
];
const NEAR_MISS: T[] = [
  R('Wait, wait, {rolled}? On a {target} target? That is a crime against sloths.', 'surprised', 'surprised', 'surprise'),
  R('{rolled}! It touched the dream and then just... walked away. Chat, did you see that?', 'surprised', 'dramatic', 'surprise'),
  R('Missed by a whisker. And sloth whiskers are long. That one hurt.', 'sad', 'dramatic', 'facepalm'),
  R("{rolled} when we needed {target}. I'm leaning back in my chair for this one.", 'surprised', 'surprised', 'surprise'),
  R('So close I could smell the {target}. It smelled like victory and leaves.', 'disappointed', 'dramatic', 'facepalm'),
  R("Hold on, {rolled}? The game is doing this on purpose. I know it is.", 'suspicious', 'suspicious', 'suspicious'),
  R("Oh, that was RIGHT there. {rolled}! My heart did a full-speed sloth sprint.", 'surprised', 'excited', 'surprise'),
  R('{rolled}. On {target}. I need a minute. Possibly a nap.', 'sad', 'dramatic', 'facepalm'),
  R('That {rolled} was flirting with {target} and then ghosted us.', 'suspicious', 'sarcastic', 'suspicious'),
  R("The game said {rolled}. The target said {target}. My heart said no.", 'surprised', 'dramatic', 'surprise'),
  R("A hair short! {rolled}! Sloth hair, which is famously long, but still!", 'surprised', 'excited', 'surprise'),
];
const LOSS_STREAK: T[] = [
  R("That's {streak} in a row. Chat, I need everyone to stay calm. I am not staying calm.", 'angry', 'dramatic', 'facepalm'),
  R("{streak} misses straight. I'm a sloth, I'm used to slow progress, but this is a lot.", 'disappointed', 'sarcastic', 'shrug'),
  R('Streak of {streak}. Somebody check if the game is napping like me.', 'suspicious', 'sleepy', 'suspicious'),
  R("{streak} in a row. Reminder, this is demo money and pure entertainment. Zero regrets, just vibes.", 'disappointed', 'calm', 'bad_result'),
  R("Loss number {streak}. I'm calling this character development.", 'thinking', 'sarcastic', 'thinking'),
  R("{streak} straight. At this point the game owes me a hibiscus and an apology.", 'angry', 'playful', 'facepalm'),
  R("We are {streak} deep in the struggle, chat. The hat has seen worse. Barely.", 'disappointed', 'dramatic', 'hat_tip'),
  R("{streak} straight. The bow tie is now officially a mood ring, and the mood is grey.", 'disappointed', 'sarcastic', 'bow_tie'),
  R("Losing streak at {streak}. I've had naps longer than this, so I'm not worried.", 'sleepy', 'relaxed', 'sleepy'),
  R("{streak} in a row. If this were a sloth race, we'd still be winning. Sort of.", 'confident', 'playful', 'shrug'),
];
const WIN_TINY: T[] = [
  R('A little {multiplier} win. We take those quietly, with dignity.', 'happy', 'relaxed', 'nod'),
  R('{multiplier}. Not glamorous, but neither is hanging upside down all day, and I love that.', 'happy', 'warm', 'nod'),
  R('Green is green, chat. {multiplier} accepted.', 'confident', 'relaxed', 'confident'),
  R('A modest {multiplier}. I shall allow it.', 'confident', 'playful', 'bow_tie'),
  R('{multiplier} landed. Small wins, big smile. Very sloth.', 'happy', 'warm', 'nod'),
];
const WIN_SMALL: T[] = [
  R('There it is, {multiplier}! Smooth, classy, just like the hat.', 'happy', 'excited', 'hat_tip'),
  R("{multiplier}! I'd do a little dance, but that sounds exhausting. Imagine I did one.", 'laughing', 'playful', 'laughing'),
  R('{multiplier} hit! Chat, act casual. Act like we planned it.', 'mischievous', 'playful', 'mischief'),
  R('Called it. Well, I thought it. Quietly. {multiplier}.', 'confident', 'mischievous', 'confident'),
  R('{multiplier}. The bow tie is officially straightened.', 'happy', 'warm', 'bow_tie'),
  R("We got the {multiplier}! That's what happens when you believe, slowly.", 'happy', 'excited', 'clap'),
  R("{multiplier}, and I didn't even have to wake up fully. Efficiency.", 'sleepy', 'playful', 'confident'),
  R('{multiplier} landed. Polite applause, please. Slow applause.', 'happy', 'playful', 'clap'),
  R("Look at that, {multiplier}. The hat knew. The hat always knows.", 'confident', 'mischievous', 'hat_tip'),
  R("{multiplier}! A tasteful win. Very on brand.", 'confident', 'relaxed', 'bow_tie'),
  R("Got the {multiplier}. I'm going to celebrate by sitting very still.", 'happy', 'playful', 'nod'),
];
const WIN_MED: T[] = [
  R('Okay, {multiplier}! That multiplier just walked into the room like it owns the place.', 'excited', 'excited', 'lean_in'),
  R("Hold on. {multiplier}? I'm awake. I'm fully awake now.", 'surprised', 'surprised', 'surprise'),
  R("{multiplier}! Somebody tell my hat, it's going to want to know about this.", 'excited', 'excited', 'hat_tip'),
  R('Chat, did you see that? {multiplier}! I moved faster than I have all week.', 'excited', 'hyped', 'clap'),
  R("{multiplier}! That's not a win, that's a statement.", 'confident', 'excited', 'confident'),
  R("{multiplier}! Okay, that one actually woke me up.", 'surprised', 'excited', 'surprise'),
  R("Now we're talking! {multiplier}! The bow tie is spinning, metaphorically.", 'excited', 'excited', 'bow_tie'),
  R("{multiplier}! Chat, hold my leaves.", 'excited', 'hyped', 'lean_in'),
  R("Oh, {multiplier}, hello there. Please, make yourself at home.", 'confident', 'playful', 'confident'),
  R("{multiplier}! That's the kind of number I'd climb down a tree for.", 'excited', 'excited', 'clap'),
  R("A {multiplier} hit! I'd jump for joy but I'd need a week's notice.", 'laughing', 'playful', 'laughing'),
];
const WIN_BIG: T[] = [
  R("No way. No way! {multiplier}! Chat, I need everyone to stay calm. I am absolutely not staying calm!", 'celebrating', 'hyped', 'big_win'),
  R("{multiplier}! That's the kind of number sloths write songs about! Slow songs, but still!", 'celebrating', 'hyped', 'big_win'),
  R('Wait a second. Did you guys see that? {multiplier}! Somebody clip it!', 'celebrating', 'hyped', 'big_win'),
  R("{multiplier}!! Top hat off. Okay, top hat back on, it's chilly. But wow!", 'celebrating', 'hyped', 'big_win'),
  R("{multiplier}! I have not moved this fast in years! Somebody check on me!", 'celebrating', 'hyped', 'big_win'),
  R("Chat! {multiplier}! The sloth has awakened, and he is thrilled!", 'celebrating', 'hyped', 'big_win'),
  R("{multiplier}! That's going in the highlight reel. The slow-motion one.", 'celebrating', 'excited', 'celebration'),
  R("Are you seeing this? {multiplier}! My hat almost flew off!", 'celebrating', 'hyped', 'big_win'),
  R("{multiplier}! Okay, nobody panic. I'm panicking a little. Happy panicking.", 'excited', 'hyped', 'celebration'),
  R("{multiplier}!! That is ridiculous! Play money, sure, but what a moment!", 'celebrating', 'hyped', 'big_win'),
];
const WIN_HUGE: T[] = [
  R("{multiplier}! That's the biggest thing that's happened to me since I climbed a tree in under an hour!", 'celebrating', 'hyped', 'big_win'),
  R('Chat. Chat. CHAT. {multiplier}! Demo money, but my heart does not know that!', 'celebrating', 'hyped', 'big_win'),
];
const PUSH: T[] = [
  R('Even. Nothing lost, nothing gained. Very zen.', 'thinking', 'calm', 'nod'),
  R('A tie. The game and I have agreed to respect each other. Briefly.', 'confident', 'sarcastic', 'shrug'),
];
const UNKNOWN: T[] = [
  R("Round {n} is done{rolled_sfx}. Let's call that one... a mystery. Very dramatic.", 'thinking', 'playful', 'thinking'),
  R("That one finished{rolled_sfx}. I'll be honest, I blinked. Slowly. Let's see the next one.", 'sleepy', 'relaxed', 'sleepy'),
  R("Round {n} in the books{rolled_sfx}. The game is keeping its secrets.", 'suspicious', 'mischievous', 'suspicious'),
];
const GROUPED: T[] = [
  R("Two rounds, two different moods. {prev} then {now}. Emotional rollercoaster, sloth edition.", 'thinking', 'playful', 'shrug'),
  R("Back to back: {prev}, then {now}. I'm keeping up. Mostly.", 'idle', 'relaxed', 'nod'),
  R("Quick double. {prev} and {now}. The game is speed-running my feelings.", 'mischievous', 'sarcastic', 'mischief'),
];

/* ───────────── spontaneous content ───────────── */
const STORIES = [
  "True story: I once fell asleep halfway through saying hello. The other sloth finished the sentence for me. Three days later.",
  "Story time. I tried to order fast food once. By the time I said what I wanted, it was slow food. Delicious, though.",
  "Fun memory: my first top hat was a coconut shell. Didn't fit. Smelled amazing. Zero regrets.",
  "When I was a young sloth, I wanted to be a racing driver. I was told, very slowly, no.",
  "I once spent a whole afternoon deciding which branch to nap on. Picked the first one. Classic.",
  "Fun fact about me: I learned to tie this bow tie from a toucan. He was terrible at it. So am I. We're both proud.",
  "The hat has a backstory. I found it at a jungle gala. Nobody claimed it. I've been fancy ever since.",
  "I tried yoga once. Held one pose for six hours. The instructor went home. I won, I think.",
];
const OBSERVATIONS = [
  "You know what I love about this game? It's honest. Brutally, rudely honest.",
  "Has anyone noticed the multiplier always slows down right when I lean in? Suspicious. Very suspicious.",
  "The thing nobody tells you about hosting a stream is how hard it is to look this relaxed.",
  "I've been watching that number climb all day and I swear it's starting to recognise me.",
  "Observation: every time I adjust my bow tie, something happens. I'm not saying it's magic. I'm saying it's fashion.",
  "Random thought: if this game were a sloth, it would be the cheeky one who steals your leaves.",
  "Honestly, best part of the stream so far is you lot. The numbers are a close second. Okay, third. After naps.",
];
const CHAT_QUESTIONS = [
  'Chat, where are you watching from tonight? Bonus points for anywhere with trees.',
  'Question for chat: if you were a sloth, what would you name your favourite branch?',
  'Chat, rate the bow tie out of ten. Be honest. Actually, be kind.',
  'Tell me one good thing that happened to you today, chat. I want the wholesome stuff.',
  'Settle this for me, chat. Is a hot dog a sandwich? I need answers, slowly.',
  "Chat, what should my next hat be? I'm thinking taller. Much taller.",
  'Quick poll: are you a morning person, a night person, or a sloth person, which is neither?',
  "What's everyone snacking on right now? I'm on leaves. Again. Living the dream.",
  'If I had a catchphrase, what would it be? Chat, I trust you. Mostly.',
  "Chat, what's the slowest thing you've ever done on purpose? I want to feel seen.",
];
const SLOTH_JOKES = [
  "Why did the sloth become a stand-up comic? Great timing. Eventually.",
  "My doctor told me to be more active, so now I blink twice as often. Progress.",
  "I don't have a hustle mindset. I have a hang-out mindset. Upside down, mostly.",
  "I tried speed-running once. Took me four days. New personal best.",
  "People ask why I wear a tuxedo. Because pyjamas didn't get past the dress code.",
  "Why do sloths make terrible secret agents? We never finish the mission. We finish the nap.",
  "My fitness tracker sent me a message. It just said, are you okay.",
  "What do you call a sloth in a top hat? Underrated. Also me.",
  "I'm not lazy. I'm in energy-saving mode. Like your phone at four percent.",
  "Sloths only come down from trees about once a week. I relate. Today was that day.",
];
const ANTICIPATION = [
  "Okay, I've got a feeling about the next one. Not a promise, just a sloth-sized feeling.",
  "Everybody lean in for this next round. Slowly. Like me.",
  "Next round, I'm adjusting the bow tie first. For science.",
  "Something about the next one feels dramatic. Or I'm just hungry. Let's find out.",
];
const HAT_BITS = [
  "Quick hat check. Still majestic. Still golden H. We're good.",
  "The hat has seen things, chat. Wins, losses, a very confusing wedding. It stays on.",
  "Fun fact: this hat is older than this stream. It's also wiser. It doesn't talk, but I can tell.",
  "I adjust the hat when I'm nervous. I adjust the hat when I'm confident. I just really like the hat.",
];
const SPONT_COMBO: Record<SpontaneousMode, Combo> = {
  story: 'thinking', observation: 'suspicious', chat_question: 'point_chat', sloth_joke: 'laughing', callback: 'mischief', anticipation: 'lean_in', hat_bit: 'hat_tip',
};

const SEGMENT: Record<string, T[]> = {
  welcome: [
    R("Good evening, ladies, gentlemen and lurkers. I'm Hubie, welcome to the house party. Demo games, bad jokes, great hat.", 'happy', 'warm', 'welcome_wave'),
    R("We're live! I'm Hubie. House rules: play money only, it's all for fun, and you must be eighteen plus. Let's have a good time.", 'happy', 'excited', 'welcome_wave'),
    R("Welcome, welcome. Grab a branch, get comfy. I'm Hubie, and tonight we're playing demo games and not taking ourselves seriously.", 'confident', 'friendly', 'welcome_wave'),
  ],
  chat_time: CHAT_QUESTIONS.map((q) => R(q, 'happy', 'friendly', 'point_chat')),
  funny: SLOTH_JOKES.map((q) => R(q, 'laughing', 'playful', 'laughing')),
  viewer_questions: [
    R('Question corner is open. Ask me anything, within reason. Sloth reason.', 'happy', 'friendly', 'point_chat'),
    R("Got a question for a sloth in a tuxedo? Now's your moment, chat. I'll answer the best ones.", 'confident', 'friendly', 'point_chat'),
  ],
  random_moment: [...STORIES, ...OBSERVATIONS].map((q) => R(q, 'thinking', 'relaxed', 'thinking')),
  break: [
    R('Quick breather, chat. Stretch, hydrate, look at something far away. Doctor sloth\'s orders.', 'sleepy', 'calm', 'sleepy'),
    R('Short pause. Remember, play responsibly, take breaks, and never play with money you need. Back in a moment.', 'confident', 'calm', 'nod'),
    R("I'm taking a tiny nap. Thirty seconds. Okay, maybe forty. Don't go anywhere.", 'sleepy', 'sleepy', 'sleepy'),
  ],
  return: [
    R("And we're back. Hat's on, bow tie's straight, let's play.", 'confident', 'excited', 'bow_tie'),
    R('Break is over. I napped for most of it. Feeling incredible.', 'happy', 'warm', 'hat_tip'),
    R("Aaand we're back. Did anything happen while I was gone? Don't answer that.", 'mischievous', 'playful', 'mischief'),
  ],
  bonus_hype: [
    R('Feeling something special in the air, chat. Could be a bonus. Could be the leaves I had for lunch.', 'excited', 'dramatic', 'lean_in'),
    R("After a moment like that, I need a second. And a snack. And a slow victory lap.", 'happy', 'excited', 'celebration'),
  ],
  celebration: [
    R('That deserves a proper celebration. Chat, give it up for the slowest party animal on the internet!', 'celebrating', 'hyped', 'celebration'),
  ],
  gameplay: [
    R("Back to the games. Let's see what we've got.", 'confident', 'relaxed', 'point_game'),
    R("Alright, a few more rounds. Eyes on the game, hat on the head.", 'confident', 'relaxed', 'point_game'),
    R("Let's get back into it. Slowly. Elegantly. Like a sloth in a tux.", 'confident', 'playful', 'bow_tie'),
  ],
};

const CAPTIONS: Record<string, string[]> = {
  loss: ['HUBIE IS NOT IMPRESSED.', 'THAT WAS PERSONAL.', 'THE GAME CHOSE VIOLENCE.', 'NOTED. FILED. FORGOTTEN.', 'RUDE, BUT FAIR.', 'BOW TIE: LOOSENED.'],
  near: ['SO. CLOSE.', 'WAIT... WHAT JUST HAPPENED?', 'BY A WHISKER.', 'THAT HURT.', 'ROBBED. ALLEGEDLY.'],
  streak: ['THIS IS FINE.', 'CHARACTER DEVELOPMENT.', 'STILL STANDING. BARELY.', 'THE STRUGGLE IS REAL.'],
  smallwin: ['SMOOTH.', 'WE TAKE THOSE.', 'HAT: TIPPED.'],
  medwin: ['THE SLOTH IS AWAKE.', 'OH, HELLO THERE.', 'NOW WE\'RE TALKING.'],
  bigwin: ['THE SLOTH HAS AWAKENED.', 'CHAT, WE HAVE A SITUATION.', 'BIG. WIN. ENERGY.', 'CLIP IT. CLIP IT NOW.'],
  bonus: ['BONUS TIME!', 'EVERYBODY LOOK BUSY.', 'SOMETHING IS HAPPENING.'],
  welcome: ['THE SLOTH IS IN.', "LET'S GET COMFY."],
  joke: ['BA-DUM-TSS.', 'COMEDY, SLOWLY.'],
  suspicious: ['SUSPICIOUS...', 'HMM. HMMMM.'],
};
const CAPTION_STYLES: CaptionStyle[] = ['slam', 'stamp', 'wobble', 'type', 'glow'];

function fill(t: string, vars: Record<string, unknown>) {
  return t.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')).replace(/\s+/g, ' ').trim();
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

function compose(core: T, vars: Record<string, unknown>, tags: string[] | null, openerP = 0.35, tagP = 0.3): LineOut {
  let body = fill(core.t, vars);
  const startsLower = /^[a-z{]/.test(core.t);
  if (startsLower || chance(openerP)) {
    const op = startsLower ? pick(OPENERS) : chance(0.5) ? pick(OPENERS) : '';
    const rest = /[.!?]$/.test(op) ? cap(body) : startsLower ? body : body.charAt(0).toLowerCase() + body.slice(1);
    body = op ? `${op} ${rest}` : body;
  }
  body = cap(body);
  if (tags && chance(tagP)) body += ` ${fill(pick(tags), vars)}`;
  return { text: body, expression: core.e, tone: core.v, combo: core.c };
}

function maybeCaption(pool: keyof typeof CAPTIONS, p: number, ctx: LLMContext): Pick<LineOut, 'caption' | 'captionStyle'> {
  if (!chance(p)) return {};
  const recent = new Set((ctx.recentCaptions ?? []).map((c) => c.toUpperCase()));
  const options = CAPTIONS[pool].filter((c) => !recent.has(c));
  if (!options.length) return {};
  return { caption: pick(options), captionStyle: pick(CAPTION_STYLES) };
}

/** Generate several candidates and return the first that passes the variety guard. */
function best(make: () => LineOut, ctx: LLMContext, tries = 30): LineOut {
  let first: LineOut | null = null;
  for (let i = 0; i < tries; i++) {
    const c = make();
    first ??= c;
    if (judgeVariety(c.text, ctx.recentLines).ok) return c;
  }
  return first!;
}

export function mockGenerate(sit: Situation, ctx: LLMContext): LineOut {
  switch (sit.kind) {
    case 'game_loaded': {
      const base = pick([
        `Alright, ${sit.game} is loaded up. Demo mode, play money, maximum vibes.`,
        `We're in ${sit.game}. Let's see what this game thinks of a sloth in a tuxedo.`,
        `${sit.game}, ready to go. Hat on, bow tie straight, expectations, low.`,
      ]);
      return { text: base, expression: 'confident', tone: 'friendly', combo: 'point_game' };
    }
    case 'round': {
      const vars = { multiplier: fx(sit.multiplier), target: fx(sit.target), rolled: fx(sit.rolled), streak: sit.lossStreak, n: sit.roundsPlayed, game: sit.game, rolled_sfx: sit.rolled !== undefined ? ` at ${fx(sit.rolled)}` : '' };
      if (sit.previous) {
        const desc = (r: { outcome: string; multiplier?: number; rolled?: number }) => (r.outcome === 'win' ? `a ${fx(r.multiplier)} win` : `a miss at ${fx(r.rolled)}`);
        return best(() => compose(pick(GROUPED), { prev: desc(sit.previous!), now: desc(sit) }, null, 0, 0), ctx);
      }
      if (sit.outcome === 'push') return best(() => compose(pick(PUSH), vars, null), ctx);
      if (sit.outcome === 'unknown') return best(() => compose(pick(UNKNOWN), vars, null, 0.2, 0), ctx);
      if (sit.outcome === 'loss') {
        if (sit.nearMiss && sit.rolled !== undefined && sit.target !== undefined) return { ...best(() => compose(pick(NEAR_MISS), vars, null, 0.1, 0), ctx), ...maybeCaption('near', 0.65, ctx) };
        if (sit.lossStreak >= 3 && sit.lossStreak % 2 === 1) return { ...best(() => compose(pick(LOSS_STREAK), vars, null, 0.2, 0.15), ctx), ...maybeCaption('streak', 0.5, ctx) };
        const pool = sit.brief ? LOSS_BRIEF : LOSS_CORE;
        return { ...best(() => compose(pick(pool), vars, sit.brief ? null : LOSS_TAGS, 0.3, 0.3), ctx), ...maybeCaption(chance(0.3) ? 'suspicious' : 'loss', sit.brief ? 0.06 : 0.14, ctx) };
      }
      if (sit.tier === 'huge') return { ...best(() => compose(pick(WIN_HUGE), vars, null, 0, 0), ctx), ...maybeCaption('bigwin', 1, ctx) };
      if (sit.tier === 'big') return { ...best(() => compose(pick(WIN_BIG), vars, BIG_TAGS, 0, 0.35), ctx), ...maybeCaption('bigwin', 0.95, ctx) };
      if (sit.tier === 'medium') return { ...best(() => compose(pick(WIN_MED), vars, WIN_TAGS, 0.25, 0.35), ctx), ...maybeCaption('medwin', 0.6, ctx) };
      const pool = sit.tier === 'small' ? WIN_SMALL : WIN_TINY;
      return { ...best(() => compose(pick(pool), vars, WIN_TAGS, 0.25, 0.3), ctx), ...maybeCaption('smallwin', 0.1, ctx) };
    }
    case 'bonus':
      return { ...best(() => pick([
        { text: "Bonus! We've got a bonus! Everybody, look busy!", expression: 'celebrating' as Expression, tone: 'hyped' as Emotion, combo: 'celebration' as Combo },
        { text: "Oh, something's happening. Something special is happening. Sit down, chat.", expression: 'excited' as Expression, tone: 'dramatic' as Emotion, combo: 'lean_in' as Combo },
        { text: "Bonus time! I'm putting on my serious face. This is my serious face. Very serious.", expression: 'excited' as Expression, tone: 'excited' as Emotion, combo: 'big_win' as Combo },
      ]), ctx), ...maybeCaption('bonus', 1, ctx) };
    case 'chat_reply': return chatReply(sit, ctx);
    case 'segment': {
      if (sit.segment === 'shoutouts' && sit.users?.length) {
        const names = sit.users.slice(0, 3);
        const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
        return best(() => pick([
          { text: `Shout-out time! Big thanks to ${list} for hanging out in chat. You make this branch a better place.`, expression: 'happy' as Expression, tone: 'warm' as Emotion, combo: 'chat_interaction' as Combo },
          { text: `Quick shout-out to ${list}. Real ones. The hat salutes you.`, expression: 'confident' as Expression, tone: 'friendly' as Emotion, combo: 'hat_tip' as Combo },
        ]), ctx);
      }
      const pool = SEGMENT[sit.segment] ?? SEGMENT.gameplay;
      const out = best(() => { const t = pick(pool); return { text: t.t, expression: t.e, tone: t.v, combo: t.c }; }, ctx);
      return { ...out, ...(sit.segment === 'welcome' ? maybeCaption('welcome', 0.8, ctx) : sit.segment === 'funny' ? maybeCaption('joke', 0.3, ctx) : {}) };
    }
    case 'spontaneous': return spontaneous(sit.mode, ctx);
    case 'idle_filler': return spontaneous(pick<SpontaneousMode>(['chat_question', 'observation', 'sloth_joke', 'hat_bit']), ctx);
    case 'injection_deflect': return best(() => pick([
      { text: `Nice try, ${sit.user}. The only secret I keep is how I tie this bow tie.`, expression: 'mischievous' as Expression, tone: 'playful' as Emotion, combo: 'mischief' as Combo },
      { text: `${sit.user}, I don't take orders from chat. I barely take orders from gravity.`, expression: 'confident' as Expression, tone: 'sarcastic' as Emotion, combo: 'confident' as Combo },
      { text: `Ooh, sneaky, ${sit.user}. I see what you're doing. The hat sees everything.`, expression: 'suspicious' as Expression, tone: 'suspicious' as Emotion, combo: 'suspicious' as Combo },
    ]), ctx);
  }
}

function spontaneous(mode: SpontaneousMode, ctx: LLMContext): LineOut {
  const combo = SPONT_COMBO[mode];
  if (mode === 'callback' && ctx.sessionFacts?.length) {
    const fact = pick(ctx.sessionFacts);
    return best(() => ({ text: pick([`Still thinking about earlier, when ${fact}. Good times.`, `Remember when ${fact}? I do. I think about it slowly and often.`, `Throwback to ${fact}. The hat remembers.`]), expression: 'mischievous', tone: 'mischievous', combo }), ctx);
  }
  const pool = mode === 'story' ? STORIES : mode === 'observation' ? OBSERVATIONS : mode === 'chat_question' ? CHAT_QUESTIONS : mode === 'anticipation' ? ANTICIPATION : mode === 'hat_bit' ? HAT_BITS : SLOTH_JOKES;
  const expr: Expression = mode === 'sloth_joke' ? 'laughing' : mode === 'observation' ? 'suspicious' : mode === 'anticipation' ? 'excited' : mode === 'chat_question' ? 'happy' : 'thinking';
  const tone: Emotion = mode === 'sloth_joke' ? 'playful' : mode === 'chat_question' ? 'friendly' : mode === 'anticipation' ? 'excited' : mode === 'observation' ? 'mischievous' : 'relaxed';
  return { ...best(() => ({ text: pick(pool), expression: expr, tone, combo }), ctx), ...(mode === 'sloth_joke' ? maybeCaption('joke', 0.25, ctx) : {}) };
}

/* ───────────── chat ───────────── */
const QA: Array<[RegExp, (u: string) => LineOut]> = [
  [/how (are|r) (you|u)|how's it going|hows it going|how you doing/i, (u) => L(pick([`I'm great, ${u}. Fully rested, which for a sloth means about nineteen hours of sleep.`, `${u}, I'm thriving. Slowly, but thriving.`]), 'happy', 'friendly')],
  [/what game|which game|what (are|r) (you|u) playing/i, (u) => L(`${u}, we're playing Housebets originals in demo mode. Play money only, all for fun.`, 'confident', 'friendly', 'point_game')],
  [/(are|r) (you|u) (an? )?(ai|bot|real|robot)/i, (u) => L(pick([`${u}, I'm an AI sloth in a very real tuxedo. The bow tie is non-negotiable.`, `Real? ${u}, I'm as real as this hat is fancy. Which is extremely.`]), 'mischievous', 'playful', 'bow_tie')],
  [/(will|can|do) (i|you|u|we) win|how to win|strategy|tips?\b|trick/i, (u) => L(`${u}, honestly? Nobody can promise wins. Outcomes are random. We're here for the show, not a system.`, 'thinking', 'calm', 'thinking')],
  [/real money|deposit|withdraw|cash ?out/i, (u) => L(`${u}, this stream is demo play money only. If you ever gamble for real, be eighteen plus, set limits, and only use money you can afford to lose.`, 'confident', 'calm', 'nod')],
  [/favou?rite (food|snack)/i, (u) => L(`${u}, leaves. Hibiscus if I'm feeling fancy. Which, look at me, I always am.`, 'confident', 'playful', 'bow_tie')],
  [/\bhat\b|top ?hat/i, (u) => L(pick([`${u}, the hat stays on. The hat has seen things.`, `${u}, thank you for noticing the hat. Most people just notice the sloth.`]), 'confident', 'playful', 'hat_tip')],
  [/sloth|slow|fast/i, (u) => L(`${u}, fun fact, sloths only come down from trees about once a week. I relate deeply.`, 'happy', 'warm', 'nod')],
  [/name|who (are|r) (you|u)/i, (u) => L(`I'm Hubie, ${u}. Host, sloth, tuxedo enthusiast.`, 'confident', 'friendly', 'bow_tie')],
  [/joke|funny|make me laugh/i, (u) => L(`${u}, why did the sloth get a job in IT? He was great at sleep mode.`, 'laughing', 'playful', 'laughing')],
  [/love (you|u)|ily|best streamer|you're the best/i, (u) => L(pick([`${u}, stop, you'll make my fur blush.`, `${u}, that's going straight into the hat. Emotionally.`]), 'happy', 'warm', 'chat_interaction')],
  [/bow ?tie|tux/i, (u) => L(`${u}, the bow tie is hand-tied. By me. It took a week.`, 'confident', 'playful', 'bow_tie')],
  [/sleep|tired|nap/i, (u) => L(`${u}, did someone say nap? Don't tempt me. I'm working. Technically.`, 'sleepy', 'sleepy', 'sleepy')],
  [/\bgg\b|good game|nice/i, (u) => L(pick([`Appreciate you, ${u}. Good vibes only on this branch.`, `${u} with the class. I like it.`]), 'happy', 'friendly', 'nod')],
];
function L(text: string, expression: Expression, tone: Emotion, combo?: Combo): LineOut { return { text, expression, tone, combo: combo ?? 'chat_interaction' }; }

const GREET_NEW: Array<(u: string) => string> = [
  (u) => `Welcome in, ${u}! Grab a branch, get comfy.`,
  (u) => `${u}! New face! Welcome to the house party.`,
  (u) => `Hey ${u}, first time here? You picked a great time. Probably. We'll see.`,
  (u) => `Oh hello, ${u}. Welcome. The hat welcomes you too.`,
];
const GREET_BACK: Array<(u: string) => string> = [
  (u) => `${u} is back! I saved your branch.`,
  (u) => `Look who returned. ${u}, the legend.`,
  (u) => `${u}! Missed you. Well, I was napping, but in spirit.`,
];
const GENERIC: Array<(u: string, s: string) => string> = [
  (u) => `${u}, I love that energy.`,
  (u) => `Ha, ${u}, you get it.`,
  (u) => `${u} with the quality chat. Noted, and appreciated.`,
  (u) => `${u}, I read that slowly, as one does, and I agree completely.`,
  (u) => `Okay ${u}, strong words. I respect it.`,
  (u, s) => (s ? `${u} says "${s}". Honestly? Fair.` : `${u}, fair point.`),
  (u, s) => (s ? `"${s}", says ${u}. I'm putting that on a t-shirt.` : `${u}, putting that on a t-shirt.`),
  (u) => `${u}, you're officially my favourite person in chat for the next eleven seconds.`,
];

function chatReply(sit: Extract<Situation, { kind: 'chat_reply' }>, ctx: LLMContext): LineOut {
  const u = sit.user;
  const snippet = sit.text.trim().split(/\s+/).length <= 6 && sit.text.length <= 40 ? sit.text.replace(/["\n]/g, '').trim() : '';
  const hit = QA.find(([re]) => re.test(sit.text));
  return best(() => {
    if (hit && (sit.isQuestion || chance(0.6))) {
      const a = hit[1](u);
      return sit.isNew ? { ...a, text: `Welcome in! ${a.text}` } : a;
    }
    if (sit.isQuestion) return L(pick([`Good question, ${u}. I'm going to think about it at sloth speed and get back to you.`, `${u}, I genuinely don't know, and I'm at peace with that.`, `${u}, great question. The hat is thinking. Give it a minute.`]), 'thinking', 'friendly', 'thinking');
    if (sit.isNew) return L(pick(GREET_NEW)(u), 'happy', 'friendly', 'welcome_wave');
    if (sit.isReturning) return L(pick(GREET_BACK)(u), 'happy', 'warm', 'chat_interaction');
    return L(pick(GENERIC)(u, snippet), pick<Expression>(['happy', 'mischievous', 'confident']), pick<Emotion>(['friendly', 'playful']), pick<Combo>(['chat_interaction', 'point_chat', 'nod']));
  }, ctx);
}
