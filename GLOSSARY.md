# Voice Mode Daemon

Local speech acceleration context providing shared neural text-to-speech and speech-to-text for desktop and browser hosts on the same machine, paired with a companion browser extension.

## Language

### Runtime Roles

**Voice Daemon**:
The local speech process on a user's machine that synthesizes spoken audio and transcribes recorded speech for authorized local hosts.
_Avoid_: Backend server, cloud proxy, microservice

**Host**:
A local application or browser extension (such as Obsidian, SillyTavern, or the Voice Mode browser extension) that delegates speech synthesis and dictation to the Voice Daemon.
_Avoid_: Consumer, tenant, frontend

**Fallback**:
Automatic continuation of speech synthesis or dictation through a secondary local or user-configured speech path when the Voice Daemon is unreachable or unauthorized.
_Avoid_: Degradation mode, recovery retry

### Speech & Text Domain

**Model Bundle**:
A named, integrity-verified set of neural speech weights and lexicon files stored once in the user's shared local cache and loaded on demand.
_Avoid_: Weight pack, checkpoint archive

**Speaker**:
A distinct vocal identity within a multi-speaker synthesis model, addressed by canonical name or numeric index.
_Avoid_: Persona, timbre profile

**Emotion Tag**:
An inline prosody marker in source text requesting hushed delivery or a timed pause during speech synthesis without being spoken literally.
_Avoid_: SSML command, stage direction

**Utterance**:
A bounded segment of spoken audio captured from the user's microphone for a single transcription turn.
_Avoid_: Audio clip, voice packet

**Vocabulary Replacement**:
A user-defined rule mapping commonly misrecognized spoken phrases to their intended canonical spelling after transcription.
_Avoid_: Spellcheck, autocorrect

**Side Panel**:
The browser extension's persistent companion surface for configuring the Voice Daemon connection, reading page content aloud, and dictating into focused web inputs.
_Avoid_: Popup, drawer
