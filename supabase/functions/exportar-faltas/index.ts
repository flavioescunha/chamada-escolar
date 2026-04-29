import { createClient } from "npm:@supabase/supabase-js@2";

type Entrada = {
  email: string;
  senha: string;
  turma?: string;
  data?: string; // dd/mm
  aulas?: number[];
  comando?: string; // ex.: "-faltas-hoje"
};

type Faltante = {
  numero: number;
  nome: string;
};

type ResultadoAula = {
  aula: number;
  faltantes: Faltante[];
};

type ResultadoHoje = {
  turma: string;
  periodo: string | null;
  aula: number;
  faltantes: Faltante[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function respostaJson(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: corsHeaders,
  });
}

function erro(codigo: string, mensagem: string, status = 400) {
  return respostaJson(
    {
      ok: false,
      erro: codigo,
      mensagem,
    },
    status,
  );
}

function normalizarNomeTurma(nome: string) {
  return String(nome || "").trim();
}

function parseDataDDMM(dataStr: string): string {
  const partes = String(dataStr || "").trim().split("/");
  if (partes.length !== 2) {
    throw new Error("Data inválida. Use o formato dd/mm.");
  }

  const dia = Number(partes[0]);
  const mes = Number(partes[1]);
  const ano = new Date().getFullYear();

  if (!Number.isInteger(dia) || !Number.isInteger(mes)) {
    throw new Error("Data inválida. Use o formato dd/mm.");
  }

  const data = new Date(ano, mes - 1, dia);
  const ok =
    data.getFullYear() === ano &&
    data.getMonth() === mes - 1 &&
    data.getDate() === dia;

  if (!ok) {
    throw new Error("Data inválida. Use o formato dd/mm.");
  }

  const mm = String(mes).padStart(2, "0");
  const dd = String(dia).padStart(2, "0");
  return `${ano}-${mm}-${dd}`;
}

function parseAulas(aulas: unknown): number[] {
  if (!Array.isArray(aulas)) {
    throw new Error("O campo 'aulas' deve ser uma lista de números entre 1 e 7.");
  }

  const lista = aulas
    .map((a) => Number(a))
    .filter((a) => Number.isInteger(a) && a >= 1 && a <= 7);

  const unicas = Array.from(new Set(lista)).sort((a, b) => a - b);

  if (unicas.length === 0) {
    throw new Error("Informe ao menos uma aula válida entre 1 e 7.");
  }

  return unicas;
}

function hojeIsoBrasil(): string {
  const agora = new Date();

  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);

  const ano = partes.find((p) => p.type === "year")?.value;
  const mes = partes.find((p) => p.type === "month")?.value;
  const dia = partes.find((p) => p.type === "day")?.value;

  if (!ano || !mes || !dia) {
    throw new Error("Não foi possível determinar a data de hoje.");
  }

  return `${ano}-${mes}-${dia}`;
}

async function autenticarInternamente(email: string, senha: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !anonKey) {
    throw new Error("Secrets SUPABASE_URL e SUPABASE_ANON_KEY não configurados.");
  }

  const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": anonKey,
    },
    body: JSON.stringify({
      email,
      password: senha,
    }),
  });

  if (!resp.ok) {
    return null;
  }

  const data = await resp.json();
  const accessToken = data?.access_token;
  const user = data?.user;

  if (!accessToken || !user?.id) {
    return null;
  }

  return {
    accessToken,
    userId: user.id as string,
    user,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return erro("metodo_invalido", "Use POST.", 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return erro(
        "configuracao_invalida",
        "Secrets SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configurados.",
        500,
      );
    }

    const body = (await req.json()) as Partial<Entrada>;

    const email = String(body.email || "").trim();
    const senha = String(body.senha || "").trim();
    const comando = String(body.comando || "").trim();

    if (!email) return erro("entrada_invalida", "Campo 'email' não informado.");
    if (!senha) return erro("entrada_invalida", "Campo 'senha' não informado.");

    // 1) autenticação interna
    const auth = await autenticarInternamente(email, senha);
    if (!auth) {
      return erro("login_invalido", "Email ou senha inválidos.", 401);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 2) validar professor
    const { data: professor, error: erroProfessor } = await admin
      .from("professores")
      .select("id, nome, email, disciplina, status")
      .eq("id", auth.userId)
      .maybeSingle();

    if (erroProfessor) {
      return erro("erro_consulta", "Erro ao carregar perfil do professor.", 500);
    }

    if (!professor) {
      return erro("perfil_nao_encontrado", "Perfil de professor não encontrado.", 404);
    }

    if (professor.status !== "aprovado") {
      return erro("acesso_bloqueado", "Professor não aprovado para uso do sistema.", 403);
    }

    // =========================================================
    // MODO NOVO: TODAS AS FALTAS DE HOJE EM TODAS AS TURMAS
    // =========================================================
    if (comando === "-faltas-hoje" || comando === "faltas-hoje") {
      const dataIsoHoje = hojeIsoBrasil();

      const { data: chamadasHoje, error: erroChamadasHoje } = await admin
        .from("chamadas")
        .select("id, turma_id, data_chamada, periodo, aula, criada_por")
        .eq("criada_por", professor.id)
        .eq("data_chamada", dataIsoHoje)
        .order("turma_id", { ascending: true })
        .order("periodo", { ascending: true })
        .order("aula", { ascending: true });

      if (erroChamadasHoje) {
        return erro("erro_consulta", "Erro ao carregar chamadas de hoje.", 500);
      }

      const chamadasLista = chamadasHoje || [];

      if (chamadasLista.length === 0) {
        return respostaJson({
          ok: true,
          modo: "faltas-hoje",
          data: dataIsoHoje,
          resultado: [],
        });
      }

      const turmaIds = Array.from(new Set(chamadasLista.map((c) => c.turma_id)));

      const { data: turmasInfo, error: erroTurmasInfo } = await admin
        .from("turmas")
        .select("id, nome")
        .in("id", turmaIds);

      if (erroTurmasInfo) {
        return erro("erro_consulta", "Erro ao carregar as turmas de hoje.", 500);
      }

      const nomeTurmaPorId = new Map<string, string>();
      (turmasInfo || []).forEach((t) => {
        nomeTurmaPorId.set(t.id, t.nome);
      });

      const { data: alunos, error: erroAlunos } = await admin
        .from("alunos")
        .select("id, turma_id, numero, nome")
        .in("turma_id", turmaIds)
        .eq("transferido", false)
        .order("numero", { ascending: true });

      if (erroAlunos) {
        return erro("erro_consulta", "Erro ao carregar alunos das turmas de hoje.", 500);
      }

      const alunosPorId = new Map<string, { id: string; turma_id: string; numero: number; nome: string }>();
      (alunos || []).forEach((a) => {
        alunosPorId.set(a.id, a);
      });

      const chamadaIds = chamadasLista.map((c) => c.id);

      let presencasLista: Array<{
        chamada_id: string;
        aluno_id: string;
        status: string;
        atualizado_em: string | null;
      }> = [];

      if (chamadaIds.length > 0) {
        const { data: presencas, error: erroPresencas } = await admin
          .from("presencas")
          .select("chamada_id, aluno_id, status, atualizado_em")
          .in("chamada_id", chamadaIds);

        if (erroPresencas) {
          return erro("erro_consulta", "Erro ao carregar presenças de hoje.", 500);
        }

        presencasLista = presencas || [];
      }

      const chamadaPorId = new Map<
        string,
        { turma_id: string; periodo: string | null; aula: number }
      >();

      chamadasLista.forEach((c) => {
        chamadaPorId.set(c.id, {
          turma_id: c.turma_id,
          periodo: c.periodo,
          aula: c.aula,
        });
      });

      const resultadoHoje: ResultadoHoje[] = [];

      for (const chamadaAlvo of chamadasLista) {
        const ultimoStatusPorAluno = new Map<
          string,
          { status: string; aula: number; atualizado_em: string }
        >();

        for (const item of presencasLista) {
          const dadosChamada = chamadaPorId.get(item.chamada_id);
          if (!dadosChamada) continue;

          // Só considera a mesma turma e mesmo período
          if (dadosChamada.turma_id !== chamadaAlvo.turma_id) continue;
          if ((dadosChamada.periodo || null) !== (chamadaAlvo.periodo || null)) continue;

          // Só considera até a aula alvo
          if (dadosChamada.aula > chamadaAlvo.aula) continue;

          const aluno = alunosPorId.get(item.aluno_id);
          if (!aluno) continue;

          // Garante que o aluno é da mesma turma
          if (aluno.turma_id !== chamadaAlvo.turma_id) continue;

          const atual = ultimoStatusPorAluno.get(item.aluno_id);
          const atualizadoEm = item.atualizado_em || "";

          if (
            !atual ||
            dadosChamada.aula > atual.aula ||
            (dadosChamada.aula === atual.aula && atualizadoEm > atual.atualizado_em)
          ) {
            ultimoStatusPorAluno.set(item.aluno_id, {
              status: item.status || "C",
              aula: dadosChamada.aula,
              atualizado_em: atualizadoEm,
            });
          }
        }

        const faltantes: Faltante[] = [];

        for (const [alunoId, info] of ultimoStatusPorAluno.entries()) {
          if (info.status === "F") {
            const aluno = alunosPorId.get(alunoId);
            if (aluno) {
              faltantes.push({
                numero: aluno.numero,
                nome: aluno.nome,
              });
            }
          }
        }

        faltantes.sort((a, b) => a.numero - b.numero || a.nome.localeCompare(b.nome));

        resultadoHoje.push({
          turma: nomeTurmaPorId.get(chamadaAlvo.turma_id) || "Turma não identificada",
          periodo: chamadaAlvo.periodo || null,
          aula: chamadaAlvo.aula,
          faltantes,
        });
      }

      return respostaJson({
        ok: true,
        modo: "faltas-hoje",
        data: dataIsoHoje,
        resultado: resultadoHoje,
      });
    }

    // =========================================================
    // MODO ANTIGO: UMA TURMA ESPECÍFICA
    // =========================================================

    const turmaNome = normalizarNomeTurma(String(body.turma || ""));
    const dataBr = String(body.data || "").trim();

    if (!turmaNome) return erro("entrada_invalida", "Campo 'turma' não informado.");
    if (!dataBr) return erro("entrada_invalida", "Campo 'data' não informado.");

    let dataIso: string;
    let aulas: number[];

    try {
      dataIso = parseDataDDMM(dataBr);
    } catch (e) {
      return erro("data_invalida", (e as Error).message);
    }

    try {
      aulas = parseAulas(body.aulas);
    } catch (e) {
      return erro("aulas_invalidas", (e as Error).message);
    }

    // localizar turma por nome
    const { data: turmas, error: erroTurma } = await admin
      .from("turmas")
      .select("id, nome, periodo_padrao")
      .eq("nome", turmaNome);

    if (erroTurma) {
      return erro("erro_consulta", "Erro ao localizar turma.", 500);
    }

    if (!turmas || turmas.length === 0) {
      return erro("turma_nao_encontrada", "Turma não encontrada com esse nome.", 404);
    }

    if (turmas.length > 1) {
      return erro("turma_duplicada", "Existe mais de uma turma com esse nome.", 409);
    }

    const turma = turmas[0];

    // buscar alunos da turma
    const { data: alunos, error: erroAlunos } = await admin
      .from("alunos")
      .select("id, numero, nome")
      .eq("turma_id", turma.id)
      .eq("transferido", false)
      .order("numero", { ascending: true });

    if (erroAlunos) {
      return erro("erro_consulta", "Erro ao carregar alunos da turma.", 500);
    }

    const alunosPorId = new Map<string, { id: string; numero: number; nome: string }>();
    (alunos || []).forEach((a) => {
      alunosPorId.set(a.id, a);
    });

    const aulaMax = Math.max(...aulas);

    // buscar todas as chamadas relevantes do professor até a maior aula pedida
    let queryChamadas = admin
      .from("chamadas")
      .select("id, aula, data_chamada, periodo, criada_por")
      .eq("turma_id", turma.id)
      .eq("data_chamada", dataIso)
      .eq("criada_por", professor.id)
      .lte("aula", aulaMax)
      .order("aula", { ascending: true });

    if (turma.periodo_padrao) {
      queryChamadas = queryChamadas.eq("periodo", turma.periodo_padrao);
    }

    const { data: chamadas, error: erroChamadas } = await queryChamadas;

    if (erroChamadas) {
      return erro("erro_consulta", "Erro ao carregar chamadas do dia.", 500);
    }

    const chamadasLista = chamadas || [];
    const chamadaIds = chamadasLista.map((c) => c.id);

    let presencasLista: Array<{
      chamada_id: string;
      aluno_id: string;
      status: string;
      atualizado_em: string | null;
    }> = [];

    if (chamadaIds.length > 0) {
      const { data: presencas, error: erroPresencas } = await admin
        .from("presencas")
        .select("chamada_id, aluno_id, status, atualizado_em")
        .in("chamada_id", chamadaIds);

      if (erroPresencas) {
        return erro("erro_consulta", "Erro ao carregar presenças.", 500);
      }

      presencasLista = presencas || [];
    }

    const aulaPorChamada = new Map<string, number>();
    chamadasLista.forEach((c) => {
      aulaPorChamada.set(c.id, c.aula);
    });

    const resultado: ResultadoAula[] = [];

    for (const aulaAlvo of aulas) {
      const ultimoStatusPorAluno = new Map<
        string,
        { status: string; aula: number; atualizado_em: string }
      >();

      for (const item of presencasLista) {
        const aulaDaPresenca = aulaPorChamada.get(item.chamada_id) || 0;
        if (aulaDaPresenca > aulaAlvo) continue;

        const atual = ultimoStatusPorAluno.get(item.aluno_id);
        const atualizadoEm = item.atualizado_em || "";

        if (
          !atual ||
          aulaDaPresenca > atual.aula ||
          (aulaDaPresenca === atual.aula && atualizadoEm > atual.atualizado_em)
        ) {
          ultimoStatusPorAluno.set(item.aluno_id, {
            status: item.status || "C",
            aula: aulaDaPresenca,
            atualizado_em: atualizadoEm,
          });
        }
      }

      const faltantes: Faltante[] = [];

      for (const [alunoId, info] of ultimoStatusPorAluno.entries()) {
        if (info.status === "F") {
          const aluno = alunosPorId.get(alunoId);
          if (aluno) {
            faltantes.push({
              numero: aluno.numero,
              nome: aluno.nome,
            });
          }
        }
      }

      faltantes.sort((a, b) => a.numero - b.numero || a.nome.localeCompare(b.nome));

      resultado.push({
        aula: aulaAlvo,
        faltantes,
      });
    }

    return respostaJson({
      ok: true,
      turma: turma.nome,
      data: dataIso,
      resultado,
    });
  } catch (e) {
    console.error("Erro inesperado em exportar-faltas:", e);
    return erro("erro_interno", `Erro interno: ${(e as Error).message}`, 500);
  }
});
