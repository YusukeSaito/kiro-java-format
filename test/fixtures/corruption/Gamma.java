import java.time.LocalDate;
import java.time.Duration;
import java.util.TreeMap;
import java.time.Instant;
import java.util.SortedMap;
import java.nio.file.Path;

public class Gamma {
    private final SortedMap<LocalDate, Integer> visits = new TreeMap<>();

  public void visit(LocalDate day){
        visits.merge(day, 1, Integer::sum);
      }

        public int visitsOn(LocalDate day) {
  Integer n = visits.get(day);
            return n == null ? 0 : n;
    }

public LocalDate firstDay() { return visits.isEmpty() ? null : visits.firstKey(); }
}
