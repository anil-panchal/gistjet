import { http, HttpResponse } from "msw";

const API = "https://api.github.com";

export const handlers = [
  http.get(`${API}/gists`, () => HttpResponse.json([])),

  http.post(`${API}/gists`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = `stub-${Math.random().toString(36).slice(2, 10)}`;
    return HttpResponse.json(
      {
        id,
        html_url: `https://gist.github.com/${id}`,
        public: body.public === true,
        files: body.files ?? {},
        description: body.description ?? null,
        truncated: false,
        history: [{ version: "stub-sha" }],
      },
      { status: 201 },
    );
  }),

  http.get(`${API}/gists/:id`, ({ params }) =>
    HttpResponse.json({
      id: params.id,
      html_url: `https://gist.github.com/${params.id as string}`,
      public: false,
      files: {},
      description: null,
      truncated: false,
      history: [{ version: "stub-sha" }],
    }),
  ),

  http.patch(`${API}/gists/:id`, async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return HttpResponse.json({
      id: params.id,
      html_url: `https://gist.github.com/${params.id as string}`,
      public: false,
      files: body.files ?? {},
      description: body.description ?? null,
      truncated: false,
      history: [{ version: "stub-sha-updated" }],
    });
  }),

  http.delete(`${API}/gists/:id`, () => new HttpResponse(null, { status: 204 })),
];
