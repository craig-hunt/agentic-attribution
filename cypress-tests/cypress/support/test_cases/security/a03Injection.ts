import {
  HttpStatus,
  InjectionPayloads,
  Publishers,
  Queries,
  SecurityProbes,
  XssProbe,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import driverActions from '../../actions/driverActions';
import navigationActions from '../../actions/navigationActions';
import { publisherUrl } from '../../constants/routes';

// OWASP A03: Injection.
describe('A03 Injection', () => {
  // Every query in this codebase passes parameters separately from SQL. A
  // payload that reached the planner would either error or return rows it was
  // never asked for, and both look different from a clean not-found.
  it('treats SQL metacharacters in a publisher identifier as data', () => {
    for (const payload of [
      InjectionPayloads.SqlComment,
      InjectionPayloads.SqlTautology,
      InjectionPayloads.SqlUnion,
      InjectionPayloads.SqlDrop,
    ]) {
      driverActions.publisher(payload).then((response) => {
        // Not found is the correct answer: no publisher carries that name.
        // A 500 would mean the string reached the database as syntax.
        expect(response.status).to.equal(HttpStatus.NotFound);
      });
    }
  });

  it('leaves the catalog intact after a destructive payload', () => {
    driverActions.publisher(InjectionPayloads.SqlDrop).then(() => {
      driverActions.publishers().then((response) => {
        expect(response.status).to.equal(HttpStatus.Ok);
        expect(response.body.publishers).to.have.length.of.at.least(1);
      });
    });
  });

  it('treats SQL metacharacters in a search query as search text', () => {
    agentActions.search(InjectionPayloads.SqlTautology, Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
      expect(response.body.products).to.be.an('array');
    });
  });

  // The dashboard renders product titles, merchant names, and query text that
  // all originate in generated or caller-supplied data. Escaping on output is
  // the control, and this asserts it holds.
  it('escapes markup rather than executing it', () => {
    agentActions.search(InjectionPayloads.ScriptTag, Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
    });

    navigationActions.visitPublisher(Publishers.Demo);

    cy.window().then((win) => {
      expect((win as unknown as Record<string, unknown>)[XssProbe.GlobalFlag]).to.equal(undefined);
    });
  });

  it('renders an injected identifier as text on the error page', () => {
    cy.visit(publisherUrl(InjectionPayloads.ImageOnError), { failOnStatusCode: false });

    cy.window().then((win) => {
      expect((win as unknown as Record<string, unknown>)[XssProbe.GlobalFlag]).to.equal(undefined);
    });

    // The payload may appear as visible text. It must never appear as markup
    // the browser parsed into an element.
    cy.get('img[onerror]').should('not.exist');
    cy.get('script').each((script) => {
      expect(script.text()).to.not.contain(XssProbe.GlobalFlag);
    });
  });

  it('answers an injected identifier without leaking database detail', () => {
    driverActions.publisher(InjectionPayloads.SqlUnion).then((response) => {
      const body = JSON.stringify(response.body);

      for (const marker of SecurityProbes.StackTraceMarkers) {
        expect(body).to.not.contain(marker);
      }
      expect(body.toLowerCase()).to.not.contain('syntax error');
    });
  });

  it('accepts a legitimate query containing an apostrophe', () => {
    // Proves the refusals above come from the payloads rather than from a
    // filter that rejects punctuation wholesale.
    agentActions.search(`${Queries.Default}'s`, Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
    });
  });
});
