import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast, MOCK, SITE } from './helpers.js';

/** Run the responder until it has written the answer to this reply (earlier specs leave other replies in the inbox). */
async function answerFor(request, replyId) {
  for (let i = 0; i < 8; i++) {
    const t = await api(request, 'POST', '/test/responder-tick');
    const w = t.written.find((x) => x.replyId === replyId);
    if (w) return w;
  }
  throw new Error(`no answer written for reply ${replyId}`);
}

// Research reads each website and lists what is missing; the first email is written from that; businesses
// without a website come from their map listing; people who write back get an answer in the same thread.
test.describe.serial('Website audit, detailed emails, no-website leads and answers to replies', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', { pipeline_mode: 'simple', groq_api_key: 'groq-test', daily_send_limit: '200', auto_reply_mode: 'auto', booking_link: '' });
    await request.post(`${MOCK}/__groq-mode`, { data: { mode: 'good' } });
  });
  test.afterAll(async ({ request }) => {
    await api(request, 'PUT', '/settings', { pipeline_mode: 'strict', groq_api_key: '', autopilot_enabled: '0', groq_base_url: '' });
  });

  let dental; let realty;
  test('research audits the website: what is missing, why it matters, what we would build', async ({ page, request }) => {
    dental = (await api(request, 'POST', '/companies', { name: 'Brightway Dental', domain: 'brightway-dental.com', website: SITE.dental, industry: 'Dentists', offer: 'C', lead_origin: 'openstreetmap' })).company;
    realty = (await api(request, 'POST', '/companies', { name: 'Lakeside Realty', domain: 'lakeside-realty.com', website: SITE.realty, industry: 'Real estate agents', offer: 'C', lead_origin: 'openstreetmap' })).company;
    await api(request, 'POST', `/companies/${dental.id}/verify`);
    await api(request, 'POST', `/companies/${realty.id}/verify`);

    const d = (await api(request, 'GET', `/companies/${dental.id}`)).company;
    const audit = JSON.parse(d.audit);
    expect(audit.profile).toBe('health');
    const keys = audit.findings.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['pdf_forms', 'phone_booking', 'not_mobile', 'outdated']));
    expect(audit.findings[0].weight).toBe(5); // strongest first
    expect(audit.findings.find((f) => f.key === 'pdf_forms').observed).toContain('New Patient Registration Form');
    expect(d.gaps).toContain(',pdf_forms,');

    const r = JSON.parse((await api(request, 'GET', `/companies/${realty.id}`)).company.audit);
    expect(r.profile).toBe('real_estate');
    expect(r.findings[0].key).toBe('listings_offsite');
    expect(r.findings[0].observed).toContain('Zillow');
    expect(r.findings.map((f) => f.key)).toEqual(expect.arrayContaining(['no_valuation', 'no_crm']));
    expect(r.findings.map((f) => f.key)).not.toContain('not_mobile'); // this site works on phones

    await page.goto(`/#/company/${dental.id}`);
    const card = page.getByTestId('audit-card');
    await expect(card).toContainText('Website audit');
    await expect(card.getByTestId('finding').first()).toContainText(/PDFs|call/);
    await expect(card).toContainText('What we would build');
  });

  test('the lead list filters on website gaps', async ({ page }) => {
    await page.goto('/#/companies');
    await page.getByTestId('gap-paper').click();
    await expect(page).toHaveURL(/gap=paper/);
    await expect(page.getByTestId('company-row').filter({ hasText: 'Brightway Dental' })).toBeVisible();
    await expect(page.getByTestId('company-row').filter({ hasText: 'Lakeside Realty' })).toHaveCount(0);
    await expect(page.getByTestId('company-row').filter({ hasText: 'Brightway Dental' }).getByTestId('row-gaps')).toContainText('Paper/PDF forms');
  });

  test('the first email is written from the audit: what we saw, what it costs, what we would build', async ({ page, request }) => {
    await page.goto(`/#/company/${dental.id}`);
    await page.getByTestId('studio-ai').click();
    await expectToast(page, 'Written from the website audit');
    await expect(page.getByTestId('studio-body')).toHaveValue(/AI-WRITTEN detailed note/);
    const { lastPrompt } = await (await request.get(`${MOCK}/__state`)).json();
    expect(lastPrompt).toContain('OBSERVATIONS FROM THEIR WEBSITE');
    expect(lastPrompt).toContain('New Patient Registration Form');
    expect(lastPrompt).toContain('WHY:');
    expect(lastPrompt).toContain('a short written plan for their site with a fixed price');
    expect(lastPrompt).not.toContain('Their website uses'); // raw tech lists are not handed to the detailed writer
  });

  test('with AI on, a template is never approved: if Groq is unreachable the email waits and is retried', async ({ page, request }) => {
    const c = await createReadyCompany(request, 'Groq Down Co', { offer: 'C', industry: 'Dentists' });
    expect(c.status).toBe('READY');
    await api(request, 'PUT', '/settings', { groq_base_url: 'http://127.0.0.1:4599/nothing' });
    const run = await api(request, 'POST', '/autopilot/run');
    expect(run.waitingForAi).toBeGreaterThanOrEqual(1);
    const m = (await api(request, 'GET', '/outreach/messages')).find((x) => x.company_id === c.id);
    expect(m.status).toBe('draft');
    expect(m.writer).toBe('template');
    expect(m.ai_error).toContain('Groq');
    await page.goto('/#/outreach');
    await expect(page.getByTestId('msg-row').filter({ hasText: 'Groq Down Co' }).getByTestId('ai-wait')).toContainText('never sent as it is');
    await api(request, 'PUT', '/settings', { autopilot_enabled: '1' }); // the schedule page explains it (scheduler is off in tests)
    const au = await api(request, 'GET', '/automation');
    expect(au.rows.find((r) => r.key === 'writing').reason).toMatch(/waiting for the AI writer/);
    await api(request, 'PUT', '/settings', { autopilot_enabled: '0' });

    // Groq is back: the next run writes it and only then approves it
    await api(request, 'PUT', '/settings', { groq_base_url: `${MOCK}/openai/v1` });
    await api(request, 'POST', '/autopilot/run');
    const after = (await api(request, 'GET', '/outreach/messages')).find((x) => x.company_id === c.id);
    expect(after.writer).toBe('ai');
    expect(after.status).toBe('approved');
    expect(after.body).toContain('AI-WRITTEN');
  });

  test('a business without a website comes from its map listing and gets the "no website" email', async ({ request }) => {
    const found = await api(request, 'POST', '/finder/search', { category: 'restaurants', location: 'Austin, TX' });
    const corner = found.results.find((x) => x.name === 'Corner Kitchen');
    expect(corner.noWebsite).toBe(true);
    expect(corner.email).toBe('cornerkitchen.atx@gmail.com');
    const imp = await api(request, 'POST', '/finder/import', { results: [corner] });
    expect(imp.created + imp.merged).toBe(1); // the lead engine (spec 15) may already have added it
    const row = (await api(request, 'GET', '/companies?search=cornerkitchen')).rows[0];
    expect(row.domain).toMatch(/\.no-website\.invalid$/);
    expect(row.email_evidence_type).toBe('map_listing');
    const v = await api(request, 'POST', `/companies/${row.id}/verify`);
    expect(v.log.join(' ')).toContain('No website');
    expect(v.after).toBe('READY');
    const c = (await api(request, 'GET', `/companies/${row.id}`)).company;
    const audit = JSON.parse(c.audit);
    expect(audit.findings.map((f) => f.key)).toEqual(expect.arrayContaining(['no_website', 'free_email']));
    expect(c.personalization).toContain("couldn't find a website");
    expect(c.gaps).toContain(',no_website,');
  });

  let sent;
  test('someone writes back interested: the answer is written and goes out in the same thread', async ({ page, request }) => {
    const c = await createReadyCompany(request, 'Answer Me Co', { fit_score: 9 });
    const d = await api(request, 'POST', '/outreach/drafts', { companyIds: [c.id] });
    await api(request, 'POST', '/outreach/approve', { ids: d.ids });
    expect((await api(request, 'POST', `/outreach/send/${d.ids[0]}`)).ok).toBe(true);
    sent = (await api(request, 'GET', '/outreach/messages')).find((x) => x.id === d.ids[0]);
    const r = await api(request, 'POST', '/test/inbound', { messageId: '<ans1@them>', from: sent.to_email, subject: `Re: ${sent.subject}`, inReplyTo: sent.message_id, date: new Date().toISOString(), headers: '',
      text: 'Hi Alex, yes please send the plan over, sounds good.\n\nSam\n\nOn Mon, Alex wrote:\n> old' });
    expect(r.classification).toBe('positive');

    const w = await answerFor(request, r.replyId);
    expect(w.auto).toBe(true);
    const sendAt = new Date(w.sendAt).getTime();
    expect(sendAt).toBeGreaterThan(Date.now() + 10 * 60_000); // a human-like pause, never instant
    const before = (await api(request, 'GET', '/test/captured')).length;
    expect((await api(request, 'POST', '/test/responder-tick')).sent).toBe(0); // not due yet

    await page.goto('/#/replies');
    const row = page.getByTestId('reply-row').filter({ hasText: 'Answer Me Co' });
    await expect(row.getByTestId('answer')).toHaveAttribute('data-state', 'queued');
    await expect(row.getByTestId('answer-body')).toContainText('AI-ANSWER');
    await row.getByTestId('answer-send').click();
    await expectToast(page, 'Answer sent');
    await expect(page.getByTestId('reply-row').filter({ hasText: 'Answer Me Co' }).getByTestId('answer')).toHaveAttribute('data-state', 'sent');

    const mails = await api(request, 'GET', '/test/captured');
    expect(mails.length).toBe(before + 1);
    const mail = mails[mails.length - 1];
    expect(mail.to).toBe(sent.to_email);
    expect(mail.subject).toBe(`Re: ${sent.subject}`);
    expect(mail.inReplyTo).toBe('<ans1@them>');
    expect(mail.text).toContain('AI-ANSWER');
    expect(mail.text).toContain('> Hi Alex, yes please send the plan over'); // their message, quoted
    expect(mail.text).not.toMatch(/unsubscribe/i);
    const { lastPrompt } = await (await request.get(`${MOCK}/__state`)).json();
    expect(lastPrompt).toContain('THEIR REPLY');
    expect(lastPrompt).toContain(sent.subject);
    // An answer does not use up the daily cold-email limit
    const q = await api(request, 'GET', '/outreach/quota');
    expect(q.sent).toBeLessThan(q.limit);
  });

  test('a price question is left for you; review mode waits for your approval', async ({ page, request }) => {
    const r = await api(request, 'POST', '/test/inbound', { messageId: '<ans2@them>', from: sent.to_email, subject: `Re: ${sent.subject}`, inReplyTo: sent.message_id, date: new Date().toISOString(), headers: '',
      text: 'Interested. How much would that cost us?' });
    expect(r.classification).toBe('positive');
    expect((await answerFor(request, r.replyId)).handoff).toContain('price');
    await page.goto('/#/replies');
    const row = page.locator('[data-testid="reply-row"][data-id="' + r.replyId + '"]');
    await expect(row.getByTestId('answer')).toHaveAttribute('data-state', 'handoff');
    await expect(row.getByTestId('answer')).toContainText('price');

    // Review mode: written, but nothing goes out until you approve it
    const c2 = await createReadyCompany(request, 'Review Answer Co', { fit_score: 9 });
    const d2 = await api(request, 'POST', '/outreach/drafts', { companyIds: [c2.id] });
    await api(request, 'POST', '/outreach/approve', { ids: d2.ids });
    await api(request, 'POST', `/outreach/send/${d2.ids[0]}`);
    const m2 = (await api(request, 'GET', '/outreach/messages')).find((x) => x.id === d2.ids[0]);
    await page.goto('/#/replies');
    await page.getByTestId('f-auto_reply_mode').selectOption('review');
    await page.getByTestId('save-answers').click();
    await expectToast(page, 'Saved');
    const q2 = await api(request, 'POST', '/test/inbound', { messageId: '<ans3@them>', from: m2.to_email, subject: `Re: ${m2.subject}`, inReplyTo: m2.message_id, date: new Date().toISOString(), headers: '', text: 'Who is this and how did you find us?' });
    expect(q2.classification).toBe('neutral');
    const w = await answerFor(request, q2.replyId);
    expect(w.auto).toBe(false);
    await api(request, 'POST', `/test/answer-due/${w.messageId}`);
    expect((await api(request, 'POST', '/test/responder-tick')).sent).toBe(0); // a draft is never sent by itself
    await page.reload(); // already on the Replies page
    const row2 = page.locator('[data-testid="reply-row"][data-id="' + q2.replyId + '"]');
    await expect(row2.getByTestId('answer')).toHaveAttribute('data-state', 'review');
    await row2.getByTestId('answer-send').click();
    await expectToast(page, 'Answer sent');
    await api(request, 'PUT', '/settings', { auto_reply_mode: 'auto' });
  });

  test('out of office: never answered, not counted, and the follow-up waits until they are back', async ({ page, request }) => {
    const c = await createReadyCompany(request, 'Away Co', { fit_score: 9 });
    const d = await api(request, 'POST', '/outreach/drafts', { companyIds: [c.id] });
    await api(request, 'POST', '/outreach/approve', { ids: d.ids });
    await api(request, 'POST', `/outreach/send/${d.ids[0]}`);
    const m = (await api(request, 'GET', '/outreach/messages')).find((x) => x.id === d.ids[0]);
    const back = new Date(Date.now() + 9 * 86400_000);
    const md = `${back.getUTCMonth() + 1}/${back.getUTCDate()}`;
    const r = await api(request, 'POST', '/test/inbound', { messageId: '<ooo@them>', from: m.to_email, subject: `OOO: until ${md} Re: ${m.subject}`, inReplyTo: m.message_id, date: new Date().toISOString(), headers: '', text: `I am out of the office until ${md} with limited access to email.` });
    expect(r.classification).toBe('auto_reply');
    const co = (await api(request, 'GET', `/companies/${c.id}`)).company;
    expect(co.status).toBe('SENT');
    expect(new Date(co.followup_after).getTime()).toBeGreaterThan(back.getTime());
    // even when the intro is old enough, no follow-up is drafted before they are back
    await api(request, 'POST', `/test/age-message/${m.id}`, { days: 10 });
    await api(request, 'POST', '/outreach/followups');
    expect((await api(request, 'GET', '/outreach/messages')).filter((x) => x.company_id === c.id && x.kind === 'follow_up')).toHaveLength(0);
    expect((await api(request, 'POST', '/test/responder-tick')).written.some((w) => w.replyId === r.replyId)).toBe(false);

    await page.goto('/#/replies');
    await expect(page.locator(`[data-testid="reply-row"][data-id="${r.replyId}"]`).getByTestId('ooo')).toContainText('follow-up waits until');
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('kpi-ooo')).toContainText('out-of-office not counted');
  });
});
