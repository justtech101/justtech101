# System 3 — Lead follow-up sequence

Fixed templates, personalised with the lead's name and need ONLY. No invented
details about their case. Timing lives in business.json (followup.steps).
Every step names the business (compliance: identify the business).

## step_1
Hi {{name}}, it's {{business_name}} — still want help with {{need}}? Happy to get you a time.

## step_2
Hi {{name}}, {{business_name}} here. {{service_note}} If you'd still like help with {{need}}, reply and {{owner_name}} will call you.

## step_2_no_note
Hi {{name}}, {{business_name}} here. If you'd still like help with {{need}}, just reply and {{owner_name}} will give you a call.

## step_3
Hi {{name}}, {{business_name}} again. Want me to book you in this week, or close this out for now? Either answer is fine.

## step_4
Hi {{name}}, last note from {{business_name}} — I'll close this out for now. If you ever need help with {{need}}, just reply here and {{owner_name}} will take care of you.

# Google Voice co-pilot variants (the owner sends these personally)

## step_2_gv
Hi {{name}}, {{business_name}} here. {{service_note}} If you'd still like help with {{need}}, just reply and I'll give you a call.

## step_2_no_note_gv
Hi {{name}}, {{business_name}} here. If you'd still like help with {{need}}, just reply and I'll give you a call.

## step_4_gv
Hi {{name}}, last note from {{business_name}} — I'll close this out for now. If you ever need help with {{need}}, just reply here and I'll take care of you.
